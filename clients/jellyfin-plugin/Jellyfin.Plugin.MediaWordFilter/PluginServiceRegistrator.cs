using Jellyfin.Plugin.MediaWordFilter.Services;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.MediaWordFilter;

/// <summary>
/// Registers plugin DI services.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHttpClient(MwfProxyService.HttpClientName);
        serviceCollection.AddSingleton<MwfProxyService>();
        // ScriptInjectionStartupTask is discovered via IScheduledTask; no hosted service.
    }
}
