using System.Net.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Services;

/// <summary>
/// Proxies HTTP requests to the Media Word Filter service.
/// </summary>
public class MwfProxyService
{
    /// <summary>
    /// Named HttpClient used for MWF requests.
    /// </summary>
    public const string HttpClientName = "MediaWordFilter";

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<MwfProxyService> _logger;

    /// <summary>
    /// Initializes a new instance of the <see cref="MwfProxyService"/> class.
    /// </summary>
    /// <param name="httpClientFactory">HTTP client factory.</param>
    /// <param name="logger">Logger.</param>
    public MwfProxyService(IHttpClientFactory httpClientFactory, ILogger<MwfProxyService> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// GET a path on the configured MWF server.
    /// </summary>
    /// <param name="relativePath">Path beginning with /.</param>
    /// <param name="cancellationToken">Cancellation token.</param>
    /// <returns>Status code and body, or null if MWF is not configured / unreachable.</returns>
    public async Task<(int StatusCode, string Body, string? ContentType)?> GetAsync(
        string relativePath,
        CancellationToken cancellationToken)
    {
        var plugin = Plugin.Instance;
        if (plugin is null)
        {
            return null;
        }

        var baseUrl = plugin.GetMwfBaseUrl();
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            _logger.LogWarning("Media Word Filter base URL is not configured");
            return null;
        }

        if (!relativePath.StartsWith('/'))
        {
            relativePath = "/" + relativePath;
        }

        var client = _httpClientFactory.CreateClient(HttpClientName);
        client.Timeout = plugin.GetRequestTimeout();

        var url = baseUrl + relativePath;
        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Get, url);
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            var body = await response.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            var contentType = response.Content.Headers.ContentType?.ToString();
            return ((int)response.StatusCode, body, contentType);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "MWF request failed: {Url}", url);
            return null;
        }
    }
}
