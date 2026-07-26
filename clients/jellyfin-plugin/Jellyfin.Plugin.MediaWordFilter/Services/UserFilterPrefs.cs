using System.Text.Json.Serialization;

namespace Jellyfin.Plugin.MediaWordFilter.Services;

/// <summary>
/// Per-Jellyfin-user filter preferences (global across all titles, syncs across devices).
/// </summary>
public sealed class UserFilterPrefs
{
    /// <summary>Master filter enable.</summary>
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>Mute blasphemy ranges.</summary>
    [JsonPropertyName("blasphemy")]
    public bool Blasphemy { get; set; } = true;

    /// <summary>Mute profanity tier 1.</summary>
    [JsonPropertyName("profanity1")]
    public bool Profanity1 { get; set; } = true;

    /// <summary>Mute profanity tier 2.</summary>
    [JsonPropertyName("profanity2")]
    public bool Profanity2 { get; set; } = true;

    /// <summary>Mute profanity tier 3.</summary>
    [JsonPropertyName("profanity3")]
    public bool Profanity3 { get; set; } = true;

    /// <summary>
    /// Global scene actions by matched label: "skip" | "block".
    /// Missing / other = off.
    /// </summary>
    [JsonPropertyName("viewMatched")]
    public Dictionary<string, string> ViewMatched { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// True when a prefs file exists for this user (GET only; not persisted).
    /// </summary>
    [JsonPropertyName("stored")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Stored { get; set; }
}
