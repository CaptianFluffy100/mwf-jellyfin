using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Hosted;

/// <summary>
/// Registers an in-memory index.html transform via the File Transformation plugin.
/// </summary>
public class ScriptInjectionHostedService : IHostedService
{
    private static readonly Guid TransformationId = Guid.Parse("b7c1d4e2-8a3f-4c9b-9e2a-1f6d8c0b5a47");

    private readonly ILogger<ScriptInjectionHostedService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionHostedService"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public ScriptInjectionHostedService(ILogger<ScriptInjectionHostedService> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc />
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        // File Transformation may load after us; retry briefly.
        for (var attempt = 1; attempt <= 10; attempt++)
        {
            try
            {
                if (TryRegisterFileTransformation())
                {
                    _logger.LogInformation("Registered Media Word Filter index.html transformation with File Transformation");
                    return;
                }
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "File Transformation registration attempt {Attempt} failed", attempt);
            }

            try
            {
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                return;
            }
        }

        _logger.LogWarning(
            "File Transformation plugin not found after retries. Install it from https://www.iamparadox.dev/jellyfin/plugins/manifest.json " +
            "so Media Word Filter can inject its Jellyfin Web client script. " +
            "Without it, details/OSD UI and auto-mute will not load.");
    }

    /// <inheritdoc />
    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    /// <summary>
    /// Callback invoked by File Transformation with a payload containing Contents.
    /// </summary>
    /// <param name="payload">Transformation payload (JSON-like object).</param>
    /// <returns>Patched file contents.</returns>
    public static string TransformIndexHtml(object payload)
    {
        var contents = ExtractContents(payload);
        if (string.IsNullOrEmpty(contents))
        {
            return contents ?? string.Empty;
        }

        const string marker = "data-mwf-plugin=\"1\"";
        if (contents.Contains(marker, StringComparison.Ordinal))
        {
            return contents;
        }

        // Drop any previous injection attempts for this plugin.
        contents = Regex.Replace(
            contents,
            "<script[^>]*MediaWordFilter/ClientScript[^>]*>\\s*</script>\\s*",
            string.Empty,
            RegexOptions.IgnoreCase);

        const string scriptTag =
            "<script defer src=\"/MediaWordFilter/ClientScript\" " + marker + "></script>";

        var idx = contents.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (idx >= 0)
        {
            return contents.Insert(idx, scriptTag + "\n");
        }

        return contents + "\n" + scriptTag + "\n";
    }

    private bool TryRegisterFileTransformation()
    {
        Assembly? fileTransformationAssembly = AssemblyLoadContext.All
            .SelectMany(static x => x.Assemblies)
            .FirstOrDefault(static x => x.FullName?.Contains(".FileTransformation", StringComparison.OrdinalIgnoreCase) == true);

        if (fileTransformationAssembly is null)
        {
            return false;
        }

        Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
        if (pluginInterfaceType is null)
        {
            _logger.LogWarning("File Transformation assembly loaded but PluginInterface type was not found");
            return false;
        }

        MethodInfo? register = pluginInterfaceType.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
        if (register is null)
        {
            _logger.LogWarning("File Transformation PluginInterface.RegisterTransformation not found");
            return false;
        }

        var payload = new
        {
            id = TransformationId,
            fileNamePattern = "index\\.html$",
            callbackAssembly = typeof(ScriptInjectionHostedService).Assembly.FullName,
            callbackClass = typeof(ScriptInjectionHostedService).FullName,
            callbackMethod = nameof(TransformIndexHtml)
        };

        register.Invoke(null, new object?[] { payload });
        return true;
    }

    private static string? ExtractContents(object payload)
    {
        if (payload is null)
        {
            return null;
        }

        // Strongly-typed property
        var prop = payload.GetType().GetProperty("Contents") ?? payload.GetType().GetProperty("contents");
        if (prop?.GetValue(payload) is string s)
        {
            return s;
        }

        // Dictionary-like
        if (payload is IDictionary<string, object> dict)
        {
            if (dict.TryGetValue("contents", out var v) || dict.TryGetValue("Contents", out v))
            {
                return v?.ToString();
            }
        }

        // JSON element / serialized anonymous
        try
        {
            var json = JsonSerializer.Serialize(payload);
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("contents", out var c) ||
                doc.RootElement.TryGetProperty("Contents", out c))
            {
                return c.GetString();
            }
        }
        catch
        {
            // ignore
        }

        return payload.ToString();
    }
}
