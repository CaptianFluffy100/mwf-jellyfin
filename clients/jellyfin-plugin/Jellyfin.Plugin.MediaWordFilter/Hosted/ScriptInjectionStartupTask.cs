using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Hosted;

/// <summary>
/// Startup task. Intentionally does <b>not</b> register File Transformation
/// for index.html — a previous no-op transform returned empty Contents when the
/// callback payload type did not bind, which blanked the entire Jellyfin Web UI
/// (details page, player, etc.).
/// </summary>
public class ScriptInjectionStartupTask : IScheduledTask
{
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
        "Media Word Filter startup (does not patch jellyfin-web index.html).";

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
        _logger.LogInformation(
            "Media Word Filter startup: not registering File Transformation for index.html " +
            "(avoids blanking Jellyfin Web). Dashboard config and /MediaWordFilter APIs remain available.");
        return Task.CompletedTask;
    }
}
