using System.Collections;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.MediaWordFilter.Hosted;

/// <summary>
/// Payload shape that File Transformation may bind when using System.Text.Json.
/// </summary>
public sealed class PatchRequestPayload
{
    /// <summary>
    /// Gets or sets the current file contents.
    /// </summary>
    [JsonPropertyName("contents")]
    public string? Contents { get; set; }
}

/// <summary>
/// Deferred startup task that registers index.html injection with File Transformation.
/// </summary>
public class ScriptInjectionStartupTask : IScheduledTask
{
    private static readonly Guid TransformationId = Guid.Parse("b7c1d4e2-8a3f-4c9b-9e2a-1f6d8c0b5a47");

    private static ILogger? _callbackLogger;

    private readonly ILogger<ScriptInjectionStartupTask> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionStartupTask"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public ScriptInjectionStartupTask(ILogger<ScriptInjectionStartupTask> logger)
    {
        _logger = logger;
        _callbackLogger = logger;
    }

    /// <inheritdoc />
    public string Name => "Media Word Filter Startup";

    /// <inheritdoc />
    public string Key => "MediaWordFilterStartup";

    /// <inheritdoc />
    public string Description =>
        "Registers the Media Word Filter client script with the File Transformation plugin.";

    /// <inheritdoc />
    public string Category => "Media Word Filter";

    /// <inheritdoc />
    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.StartupTrigger
        };
    }

    /// <inheritdoc />
    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        return Task.Run(
            () =>
            {
                for (var attempt = 1; attempt <= 15; attempt++)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    try
                    {
                        if (TryRegisterFileTransformation())
                        {
                            _logger.LogInformation(
                                "Registered Media Word Filter index.html transformation with File Transformation (attempt {Attempt})",
                                attempt);
                            return;
                        }
                    }
                    catch (Exception ex)
                    {
                        _logger.LogWarning(ex, "File Transformation registration attempt {Attempt} failed", attempt);
                    }

                    Thread.Sleep(TimeSpan.FromSeconds(2));
                }

                _logger.LogWarning(
                    "File Transformation plugin not found after retries. Install it from https://www.iamparadox.dev/jellyfin/plugins/manifest.json " +
                    "so Media Word Filter can inject its Jellyfin Web client script. " +
                    "Without it, details-page UI and auto-mute will not load.");
            },
            cancellationToken);
    }

    /// <summary>
    /// Callback invoked by File Transformation for index.html.
    /// Accepts whatever payload type FT passes (JObject, PatchRequestPayload, string, etc.).
    /// </summary>
    /// <param name="input">Current HTML payload from File Transformation.</param>
    /// <returns>Patched HTML, or the original HTML if patching cannot be done safely.</returns>
    public static string TransformIndexHtml(object? input)
    {
        if (!TryExtractHtmlContents(input, out var contents))
        {
            _callbackLogger?.LogError(
                "Media Word Filter index.html transform: could not extract HTML from payload type {Type}; skipping patch",
                input?.GetType().FullName ?? "null");

            if (input is string raw && raw.Length > 0)
            {
                return raw;
            }

            // Never return string.Empty — that blanked Jellyfin Web in 1.0.6.
            throw new InvalidOperationException(
                "Media Word Filter index.html transform: no HTML contents in payload; refusing to return empty HTML.");
        }

        if (!LooksLikeHtml(contents))
        {
            _callbackLogger?.LogWarning(
                "Media Word Filter index.html transform: payload does not look like HTML; skipping patch");
            return contents;
        }

        const string marker = "data-mwf-plugin=\"1\"";
        if (contents.Contains(marker, StringComparison.Ordinal)
            || contents.Contains("/MediaWordFilter/ClientScript", StringComparison.OrdinalIgnoreCase))
        {
            return contents;
        }

        contents = Regex.Replace(
            contents,
            "<script[^>]*MediaWordFilter/ClientScript[^>]*>\\s*</script>\\s*",
            string.Empty,
            RegexOptions.IgnoreCase);

        const string scriptTag =
            "<script defer src=\"/MediaWordFilter/ClientScript?v=1.0.10.0\" " + marker + "></script>";

        if (contents.Contains("</body>", StringComparison.OrdinalIgnoreCase))
        {
            return contents.Replace("</body>", scriptTag + "\n</body>", StringComparison.OrdinalIgnoreCase);
        }

        if (contents.Contains("</html>", StringComparison.OrdinalIgnoreCase))
        {
            return contents.Replace("</html>", scriptTag + "\n</html>", StringComparison.OrdinalIgnoreCase);
        }

        _callbackLogger?.LogWarning(
            "Media Word Filter index.html transform: no </body> or </html>; appending script tag");
        return contents + "\n" + scriptTag + "\n";
    }

    private static bool LooksLikeHtml(string contents)
    {
        return contents.Contains("<html", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("</body>", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<head", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryExtractHtmlContents(object? input, out string contents)
    {
        contents = string.Empty;

        if (input is null)
        {
            return false;
        }

        if (input is string s)
        {
            contents = s;
            return !string.IsNullOrEmpty(contents);
        }

        if (input is PatchRequestPayload payload && !string.IsNullOrEmpty(payload.Contents))
        {
            contents = payload.Contents;
            return true;
        }

        if (input is JObject jobj)
        {
            var token = jobj["contents"] ?? jobj["Contents"];
            if (token?.Type == JTokenType.String)
            {
                contents = token.ToString();
                return !string.IsNullOrEmpty(contents);
            }
        }

        if (input is JsonElement element)
        {
            if (element.ValueKind == JsonValueKind.String)
            {
                contents = element.GetString() ?? string.Empty;
                return contents.Length > 0;
            }

            if (element.TryGetProperty("contents", out var c) || element.TryGetProperty("Contents", out c))
            {
                if (c.ValueKind == JsonValueKind.String)
                {
                    contents = c.GetString() ?? string.Empty;
                    return contents.Length > 0;
                }
            }
        }

        if (input is IDictionary dict)
        {
            foreach (var key in new[] { "contents", "Contents" })
            {
                if (dict.Contains(key) && dict[key] is string ds && !string.IsNullOrEmpty(ds))
                {
                    contents = ds;
                    return true;
                }
            }
        }

        foreach (var prop in input.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!prop.Name.Equals("contents", StringComparison.OrdinalIgnoreCase)
                && !prop.Name.Equals("Contents", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (prop.GetValue(input) is string ps && !string.IsNullOrEmpty(ps))
            {
                contents = ps;
                return true;
            }
        }

        return false;
    }

    private bool TryRegisterFileTransformation()
    {
        Assembly? fileTransformationAssembly = FindFileTransformationAssembly();
        if (fileTransformationAssembly is null)
        {
            _logger.LogDebug("File Transformation assembly not visible yet");
            return false;
        }

        Type? pluginInterfaceType = fileTransformationAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
        if (pluginInterfaceType is null)
        {
            _logger.LogWarning(
                "File Transformation assembly '{Assembly}' loaded but PluginInterface type was not found",
                fileTransformationAssembly.FullName);
            return false;
        }

        MethodInfo? register = pluginInterfaceType.GetMethod("RegisterTransformation", BindingFlags.Public | BindingFlags.Static);
        if (register is null)
        {
            _logger.LogWarning("File Transformation PluginInterface.RegisterTransformation not found");
            return false;
        }

        // File Transformation's RegisterTransformation requires Newtonsoft JObject
        // (same payload shape as Jellyfin Enhanced).
        var payload = new JObject
        {
            ["id"] = TransformationId.ToString(),
            ["fileNamePattern"] = "index.html",
            ["callbackAssembly"] = typeof(ScriptInjectionStartupTask).Assembly.FullName,
            ["callbackClass"] = typeof(ScriptInjectionStartupTask).FullName,
            ["callbackMethod"] = nameof(TransformIndexHtml)
        };

        register.Invoke(null, new object?[] { payload });
        return true;
    }

    private static Assembly? FindFileTransformationAssembly()
    {
        foreach (var alc in AssemblyLoadContext.All)
        {
            foreach (var asm in alc.Assemblies)
            {
                var name = asm.FullName ?? asm.GetName().Name ?? string.Empty;
                if (name.Contains("FileTransformation", StringComparison.OrdinalIgnoreCase))
                {
                    return asm;
                }
            }
        }

        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var name = asm.FullName ?? asm.GetName().Name ?? string.Empty;
            if (name.Contains("FileTransformation", StringComparison.OrdinalIgnoreCase))
            {
                return asm;
            }
        }

        return null;
    }
}
