using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.MediaWordFilter.Configuration;

/// <summary>
/// Plugin settings stored by Jellyfin (admin Dashboard).
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// Base URL of the Media Word Filter HTTP service (e.g. http://mwf:8787).
    /// </summary>
    public string MwfBaseUrl { get; set; } = "http://127.0.0.1:8787";

    /// <summary>
    /// Outbound HTTP timeout when proxying to MWF.
    /// </summary>
    public int RequestTimeoutSeconds { get; set; } = 10;

    /// <summary>
    /// Inject profile / filter controls on the item details page.
    /// </summary>
    public bool EnableDetailsUi { get; set; } = true;

    /// <summary>
    /// Prefetch mute ranges for the next episode while watching a series.
    /// </summary>
    public bool EnablePrefetch { get; set; } = true;
}
