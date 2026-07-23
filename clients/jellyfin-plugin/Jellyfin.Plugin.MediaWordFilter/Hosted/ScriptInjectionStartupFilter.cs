using System.Text;
using Jellyfin.Plugin.MediaWordFilter.Web;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Hosted;

/// <summary>
/// Injects the MWF client script into jellyfin-web index.html at request time.
/// Primary injection path — more reliable than File Transformation callback shapes alone.
/// </summary>
public class ScriptInjectionStartupFilter : IStartupFilter
{
    private readonly ILogger<ScriptInjectionStartupFilter> _logger;
    private int _loggedOnce;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionStartupFilter"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public ScriptInjectionStartupFilter(ILogger<ScriptInjectionStartupFilter> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            app.Use(InvokeAsync);
            next(app);
        };
    }

    private async Task InvokeAsync(HttpContext context, Func<Task> nextMiddleware)
    {
        if (!ClientScriptInjection.IsWebIndexRequest(context.Request.Path.Value))
        {
            await nextMiddleware().ConfigureAwait(false);
            return;
        }

        if (!HttpMethods.IsGet(context.Request.Method))
        {
            await nextMiddleware().ConfigureAwait(false);
            return;
        }

        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("Range");
        context.Request.Headers.Remove("If-Range");

        var originalBody = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;

        try
        {
            await nextMiddleware().ConfigureAwait(false);
        }
        catch
        {
            context.Response.Body = originalBody;
            throw;
        }

        context.Response.Body = originalBody;
        buffer.Seek(0, SeekOrigin.Begin);

        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);

        if (!isHtml)
        {
            await buffer.CopyToAsync(originalBody).ConfigureAwait(false);
            return;
        }

        string html;
        using (var reader = new StreamReader(buffer, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 4096, leaveOpen: true))
        {
            html = await reader.ReadToEndAsync().ConfigureAwait(false);
        }

        try
        {
            if (ClientScriptInjection.LooksLikeHtml(html))
            {
                var patched = ClientScriptInjection.InjectIntoHtml(html);
                if (!ReferenceEquals(patched, html) && !string.Equals(patched, html, StringComparison.Ordinal))
                {
                    html = patched;
                    if (Interlocked.Exchange(ref _loggedOnce, 1) == 0)
                    {
                        _logger.LogInformation(
                            "Media Word Filter: injected the client script via request-time middleware (IStartupFilter).");
                    }
                }
            }
            else
            {
                _logger.LogDebug(
                    "Media Word Filter middleware: index response did not look like HTML; leaving unchanged (prefix={Prefix})",
                    html.Length <= 120 ? html : html[..120]);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Media Word Filter middleware: injection failed; serving original HTML");
        }

        var bytes = Encoding.UTF8.GetBytes(html);
        context.Response.ContentType = "text/html;charset=utf-8";
        context.Response.ContentLength = bytes.Length;
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.Remove("Accept-Ranges");
        await originalBody.WriteAsync(bytes).ConfigureAwait(false);
    }
}
