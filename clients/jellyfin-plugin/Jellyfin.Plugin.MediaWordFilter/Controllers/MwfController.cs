using System.Net.Mime;
using System.Security.Claims;
using System.Text;
using Jellyfin.Plugin.MediaWordFilter.Services;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Controllers;

/// <summary>
/// Serves the injected client script and proxies mute/profile APIs to MWF.
/// </summary>
[ApiController]
[Route("MediaWordFilter")]
public class MwfController : ControllerBase
{
    private readonly MwfProxyService _proxy;
    private readonly UserFilterPrefsStore _prefsStore;
    private readonly ILogger<MwfController> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="MwfController"/> class.
    /// </summary>
    /// <param name="proxy">MWF proxy.</param>
    /// <param name="prefsStore">Per-user filter prefs store.</param>
    /// <param name="logger">Logger.</param>
    public MwfController(
        MwfProxyService proxy,
        UserFilterPrefsStore prefsStore,
        ILogger<MwfController> logger)
    {
        _proxy = proxy;
        _prefsStore = prefsStore;
        _logger = logger;
    }

    /// <summary>
    /// Injected Jellyfin Web client script (CSS + JS bootstrap).
    /// </summary>
    /// <returns>JavaScript payload.</returns>
    [HttpGet("ClientScript")]
    [AllowAnonymous]
    [Produces("application/javascript")]
    public ActionResult GetClientScript()
    {
        var css = ReadEmbedded("Web.mwf-client.css");
        var js = ReadEmbedded("Web.mwf-client.js");
                        var flags = Plugin.Instance?.GetClientFlagsJson() ??
                    "{\"enableDetailsUi\":true,\"enablePrefetch\":true}";

        var sb = new StringBuilder(css.Length + js.Length + 512);
        sb.Append("(function(){");
        sb.Append("if(document.getElementById('mwf-plugin-style'))return;");
        sb.Append("var s=document.createElement('style');");
        sb.Append("s.id='mwf-plugin-style';");
        sb.Append("s.textContent=");
        sb.Append(System.Text.Json.JsonSerializer.Serialize(css));
        sb.Append(';');
        sb.Append("(document.head||document.documentElement).appendChild(s);");
        sb.Append("window.__MWF_PLUGIN__=");
        sb.Append(flags);
        sb.Append(';');
        sb.Append("})();");
        sb.Append('\n');
        sb.Append(js);

        Response.Headers["Cache-Control"] = "no-store, no-cache, must-revalidate";
        return Content(sb.ToString(), "application/javascript", Encoding.UTF8);
    }

    /// <summary>
    /// Proxy MWF health check (admin config page).
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Health JSON or error.</returns>
    [HttpGet("health")]
    [Authorize(Policy = Policies.RequiresElevation)]
    public async Task<ActionResult> Health(CancellationToken cancellationToken)
    {
        var result = await _proxy.GetAsync("/health", cancellationToken).ConfigureAwait(false);
        if (result is null)
        {
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { ok = false, error = "MWF unreachable or base URL not configured" });
        }

        return Content(result.Value.Body, result.Value.ContentType ?? MediaTypeNames.Application.Json);
    }

    /// <summary>
    /// Proxy MWF profiles list.
    /// </summary>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Profiles JSON.</returns>
    [HttpGet("profiles")]
    [Authorize]
    public async Task<ActionResult> Profiles(CancellationToken cancellationToken)
    {
        var result = await _proxy.GetAsync("/api/profiles", cancellationToken).ConfigureAwait(false);
        return ProxyResult(result);
    }

    /// <summary>
    /// Proxy mute document for an item.
    /// </summary>
    /// <param name="itemId">Jellyfin item id.</param>
    /// <param name="userId">Optional MWF profile / Jellyfin user id.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Mute document JSON.</returns>
    [HttpGet("mutes/{itemId}")]
    [Authorize]
    public async Task<ActionResult> Mutes(
        [FromRoute] string itemId,
        [FromQuery] string? userId,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(itemId))
        {
            return BadRequest(new { error = "itemId required" });
        }

        if (!(User.Identity?.IsAuthenticated ?? false))
        {
            var hasTokenHeader = Request.Headers.ContainsKey("X-Emby-Token")
                || Request.Headers.ContainsKey("Authorization");
            _logger.LogWarning(
                "Media Word Filter mute proxy: unauthenticated request for item {ItemId} (tokenHeaderPresent={HasTokenHeader}, remote={Remote})",
                itemId.Trim(),
                hasTokenHeader,
                HttpContext.Connection.RemoteIpAddress);
            return Unauthorized(new { error = "Authentication required for mute data" });
        }

        var path = "/mutes/" + Uri.EscapeDataString(itemId.Trim());
        if (!string.IsNullOrWhiteSpace(userId))
        {
            path += "?user_id=" + Uri.EscapeDataString(userId.Trim());
        }

        var result = await _proxy.GetAsync(path, cancellationToken).ConfigureAwait(false);
        return ProxyResult(result);
    }

    /// <summary>
    /// Get filter preferences for the authenticated Jellyfin user (global across titles).
    /// </summary>
    /// <returns>Prefs JSON.</returns>
    [HttpGet("prefs")]
    [Authorize]
    public ActionResult GetPrefs()
    {
        var userId = ResolveUserId();
        if (userId is null)
        {
            return Unauthorized(new { error = "Authentication required" });
        }

        var prefs = _prefsStore.Get(userId.Value);
        prefs.Stored = _prefsStore.Exists(userId.Value);
        return Ok(prefs);
    }

    /// <summary>
    /// Save filter preferences for the authenticated Jellyfin user.
    /// </summary>
    /// <param name="body">Prefs JSON.</param>
    /// <returns>Saved prefs.</returns>
    [HttpPut("prefs")]
    [Authorize]
    public ActionResult PutPrefs([FromBody] UserFilterPrefs? body)
    {
        var userId = ResolveUserId();
        if (userId is null)
        {
            return Unauthorized(new { error = "Authentication required" });
        }

        if (body is null)
        {
            return BadRequest(new { error = "prefs body required" });
        }

        try
        {
            _prefsStore.Put(userId.Value, body);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed saving MWF prefs for user {UserId}", userId);
            return StatusCode(StatusCodes.Status500InternalServerError, new { error = "Failed to save prefs" });
        }

        var saved = _prefsStore.Get(userId.Value);
        saved.Stored = true;
        return Ok(saved);
    }

    /// <summary>
    /// Public client feature flags (no secrets).
    /// </summary>
    /// <returns>Flags JSON.</returns>
    [HttpGet("config")]
    [Authorize]
    public ActionResult ClientConfig()
    {
        var plugin = Plugin.Instance;
        if (plugin is null)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        return Ok(new
        {
            enableDetailsUi = plugin.Configuration.EnableDetailsUi,
            enablePrefetch = plugin.Configuration.EnablePrefetch,
            mwfConfigured = !string.IsNullOrWhiteSpace(plugin.GetMwfBaseUrl())
        });
    }

    private Guid? ResolveUserId()
    {
        foreach (var claim in User.Claims)
        {
            var type = claim.Type ?? string.Empty;
            if (type.Equals(ClaimTypes.NameIdentifier, StringComparison.OrdinalIgnoreCase)
                || type.Equals("Jellyfin-UserId", StringComparison.OrdinalIgnoreCase)
                || type.EndsWith("/nameidentifier", StringComparison.OrdinalIgnoreCase)
                || type.Equals("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier", StringComparison.OrdinalIgnoreCase))
            {
                if (Guid.TryParse(claim.Value, out var guid))
                {
                    return guid;
                }
            }
        }

        // Fallback: some builds put the user id in Name.
        if (Guid.TryParse(User.Identity?.Name, out var fromName))
        {
            return fromName;
        }

        return null;
    }

    private ActionResult ProxyResult((int StatusCode, string Body, string? ContentType)? result)
    {
        if (result is null)
        {
            return StatusCode(
                StatusCodes.Status502BadGateway,
                new { error = "MWF unreachable or base URL not configured" });
        }

        var (status, body, contentType) = result.Value;
        return new ContentResult
        {
            StatusCode = status,
            Content = body,
            ContentType = contentType ?? MediaTypeNames.Application.Json
        };
    }

    private static string ReadEmbedded(string relativeName)
    {
        var assembly = typeof(MwfController).Assembly;
        var full = "Jellyfin.Plugin.MediaWordFilter." + relativeName;
        using var stream = assembly.GetManifestResourceStream(full);
        if (stream is null)
        {
            var available = string.Join(", ", assembly.GetManifestResourceNames());
            throw new InvalidOperationException(
                $"Embedded resource not found: {full}. Available: {available}");
        }

        using var reader = new StreamReader(stream, Encoding.UTF8);
        return reader.ReadToEnd();
    }
}
