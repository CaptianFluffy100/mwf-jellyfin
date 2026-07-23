using System.Reflection;
using System.Runtime.Loader;
using Jellyfin.Plugin.MediaWordFilter.Web;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.MediaWordFilter.Hosted;

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
        "Registers the Media Word Filter client script with the File Transformation plugin (middleware is primary).";

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

                _logger.LogInformation(
                    "File Transformation plugin not found after retries; client script still injects via request-time middleware.");
            },
            cancellationToken);
    }

    /// <summary>
    /// Callback invoked by File Transformation for index.html.
    /// </summary>
    /// <param name="input">Current HTML payload from File Transformation.</param>
    /// <returns>Patched HTML, or the original HTML if patching cannot be done safely.</returns>
    public static string TransformIndexHtml(object? input)
    {
        return ClientScriptInjection.TransformIndexHtml(input, _callbackLogger);
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

        var payload = new JObject
        {
            ["id"] = TransformationId.ToString(),
            ["fileNamePattern"] = @"(^|/)index\.html$",
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
