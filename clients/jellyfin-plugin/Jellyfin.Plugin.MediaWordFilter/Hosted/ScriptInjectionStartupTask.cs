using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Hosted;

/// <summary>
/// Payload shape expected by File Transformation callbacks.
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
/// Must run after plugins finish loading (same pattern as Jellyfin Enhanced).
/// </summary>
public class ScriptInjectionStartupTask : IScheduledTask
{
    private static readonly Guid TransformationId = Guid.Parse("b7c1d4e2-8a3f-4c9b-9e2a-1f6d8c0b5a47");

    private readonly ILogger<ScriptInjectionStartupTask> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="ScriptInjectionStartupTask"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public ScriptInjectionStartupTask(ILogger<ScriptInjectionStartupTask> logger)
    {
        _logger = logger;
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
                    "Without it, details/OSD UI and auto-mute will not load.");
            },
            cancellationToken);
    }

    /// <summary>
    /// Callback invoked by File Transformation for index.html.
    /// </summary>
    /// <param name="content">Current HTML payload.</param>
    /// <returns>Patched HTML.</returns>
    public static string TransformIndexHtml(PatchRequestPayload content)
    {
        var contents = content?.Contents;
        if (string.IsNullOrEmpty(contents))
        {
            return contents ?? string.Empty;
        }

        const string marker = "data-mwf-plugin=\"1\"";
        if (contents.Contains(marker, StringComparison.Ordinal))
        {
            return contents;
        }

        contents = Regex.Replace(
            contents,
            "<script[^>]*MediaWordFilter/ClientScript[^>]*>\\s*</script>\\s*",
            string.Empty,
            RegexOptions.IgnoreCase);

        const string scriptTag =
            "<script defer src=\"/MediaWordFilter/ClientScript\" " + marker + "></script>";

        if (contents.Contains("</body>", StringComparison.OrdinalIgnoreCase))
        {
            return contents.Replace("</body>", scriptTag + "\n</body>", StringComparison.OrdinalIgnoreCase);
        }

        return contents + "\n" + scriptTag + "\n";
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

        // Match Jellyfin Enhanced: plain "index.html" pattern + dictionary/JObject-like payload.
        var payload = new Dictionary<string, object?>
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

        // Fallback: already-loaded assemblies in the default context
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
