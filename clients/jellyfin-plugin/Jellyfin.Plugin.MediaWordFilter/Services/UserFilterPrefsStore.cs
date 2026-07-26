using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.MediaWordFilter.Services;

/// <summary>
/// Persists per-user filter prefs under the plugin data folder so they follow the Jellyfin user.
/// </summary>
public sealed class UserFilterPrefsStore
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true,
        PropertyNameCaseInsensitive = true
    };

    private readonly ILogger<UserFilterPrefsStore> _logger;
    private readonly object _gate = new();

    /// <summary>
    /// Initializes a new instance of the <see cref="UserFilterPrefsStore"/> class.
    /// </summary>
    /// <param name="logger">Logger.</param>
    public UserFilterPrefsStore(ILogger<UserFilterPrefsStore> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Load prefs for a Jellyfin user. Returns defaults when no file exists.
    /// </summary>
    /// <param name="userId">Jellyfin user id.</param>
    /// <returns>Prefs document.</returns>
    public UserFilterPrefs Get(Guid userId)
    {
        var path = PrefsPath(userId);
        lock (_gate)
        {
            try
            {
                if (!File.Exists(path))
                {
                    return new UserFilterPrefs();
                }

                var json = File.ReadAllText(path);
                var prefs = JsonSerializer.Deserialize<UserFilterPrefs>(json, JsonOptions);
                return Normalize(prefs);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to read MWF user prefs for {UserId}", userId);
                return new UserFilterPrefs();
            }
        }
    }

    /// <summary>
    /// Whether a prefs file already exists for this user.
    /// </summary>
    /// <param name="userId">Jellyfin user id.</param>
    /// <returns>True if stored.</returns>
    public bool Exists(Guid userId)
    {
        lock (_gate)
        {
            return File.Exists(PrefsPath(userId));
        }
    }

    /// <summary>
    /// Save prefs for a Jellyfin user.
    /// </summary>
    /// <param name="userId">Jellyfin user id.</param>
    /// <param name="prefs">Prefs document.</param>
    public void Put(Guid userId, UserFilterPrefs prefs)
    {
        ArgumentNullException.ThrowIfNull(prefs);
        var path = PrefsPath(userId);
        var dir = Path.GetDirectoryName(path);
        lock (_gate)
        {
            try
            {
                if (!string.IsNullOrEmpty(dir))
                {
                    Directory.CreateDirectory(dir);
                }

                var normalized = Normalize(prefs);
                var json = JsonSerializer.Serialize(normalized, JsonOptions);
                var tmp = path + ".tmp";
                File.WriteAllText(tmp, json);
                File.Move(tmp, path, overwrite: true);
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Failed to write MWF user prefs for {UserId}", userId);
                throw;
            }
        }
    }

    private static string PrefsPath(Guid userId)
    {
        var root = Plugin.Instance?.DataFolderPath
            ?? Path.Combine(Path.GetTempPath(), "Jellyfin.Plugin.MediaWordFilter");
        return Path.Combine(root, "user-prefs", userId.ToString("N") + ".json");
    }

    private static UserFilterPrefs Normalize(UserFilterPrefs? prefs)
    {
        prefs ??= new UserFilterPrefs();
        prefs.ViewMatched ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        var cleaned = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in prefs.ViewMatched)
        {
            var k = (key ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(k))
            {
                continue;
            }

            var v = (value ?? string.Empty).Trim().ToLowerInvariant();
            if (v is "skip" or "block")
            {
                cleaned[k] = v;
            }
        }

        prefs.ViewMatched = cleaned;
        prefs.Stored = null;
        return prefs;
    }
}
