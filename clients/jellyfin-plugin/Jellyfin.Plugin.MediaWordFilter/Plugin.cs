using System.Globalization;
using Jellyfin.Plugin.MediaWordFilter.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.MediaWordFilter;

/// <summary>
/// Media Word Filter Jellyfin server plugin.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>
    /// Initializes a new instance of the <see cref="Plugin"/> class.
    /// </summary>
    /// <param name="applicationPaths">Application paths.</param>
    /// <param name="xmlSerializer">XML serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("a8e3f2c1-9b4d-4e7a-8f1c-2d6b5a9e0c34");

    /// <inheritdoc />
    public override string Name => "Media Word Filter";

    /// <inheritdoc />
    public override string Description =>
        "Mutes filtered phrases during Jellyfin Web playback using Media Word Filter mute data.";

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        var ns = GetType().Namespace;
        return new[]
        {
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = ns + ".Configuration.configPage.html"
            }
        };
    }

    /// <summary>
    /// Trim trailing slashes from the configured MWF base URL.
    /// </summary>
    /// <returns>Normalized base URL, or empty if unset.</returns>
    public string GetMwfBaseUrl()
    {
        var url = Configuration.MwfBaseUrl?.Trim() ?? string.Empty;
        return url.TrimEnd('/');
    }

    /// <summary>
    /// Request timeout from configuration (clamped).
    /// </summary>
    /// <returns>Timeout.</returns>
    public TimeSpan GetRequestTimeout()
    {
        var seconds = Configuration.RequestTimeoutSeconds;
        if (seconds < 1)
        {
            seconds = 1;
        }
        else if (seconds > 120)
        {
            seconds = 120;
        }

        return TimeSpan.FromSeconds(seconds);
    }

    /// <summary>
    /// Feature flags exposed to the injected client script.
    /// </summary>
    /// <returns>Client bootstrap JSON fragment.</returns>
    public string GetClientFlagsJson()
    {
        return string.Format(
            CultureInfo.InvariantCulture,
            "{{\"enableDetailsUi\":{0},\"enablePrefetch\":{1}}}",
            Configuration.EnableDetailsUi ? "true" : "false",
            Configuration.EnablePrefetch ? "true" : "false");
    }
}
