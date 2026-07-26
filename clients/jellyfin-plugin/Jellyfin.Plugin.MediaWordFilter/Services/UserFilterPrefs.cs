using System.Text.Json.Serialization;
using Newtonsoft.Json;

namespace Jellyfin.Plugin.MediaWordFilter.Services;

/// <summary>
/// Per-Jellyfin-user filter preferences (global across all titles, syncs across devices).
/// Dual-annotated for Jellyfin's Newtonsoft API binder and System.Text.Json file store.
/// </summary>
public sealed class UserFilterPrefs
{
    /// <summary>Master filter enable.</summary>
    [JsonProperty("enabled")]
    [JsonPropertyName("enabled")]
    public bool Enabled { get; set; } = true;

    /// <summary>Mute blasphemy ranges.</summary>
    [JsonProperty("blasphemy")]
    [JsonPropertyName("blasphemy")]
    public bool Blasphemy { get; set; } = true;

    /// <summary>Mute profanity tier 1.</summary>
    [JsonProperty("profanity1")]
    [JsonPropertyName("profanity1")]
    public bool Profanity1 { get; set; } = true;

    /// <summary>Mute profanity tier 2.</summary>
    [JsonProperty("profanity2")]
    [JsonPropertyName("profanity2")]
    public bool Profanity2 { get; set; } = true;

    /// <summary>Mute profanity tier 3.</summary>
    [JsonProperty("profanity3")]
    [JsonPropertyName("profanity3")]
    public bool Profanity3 { get; set; } = true;

    /// <summary>
    /// Global scene actions by matched label: "skip" | "block".
    /// Missing / other = off.
    /// </summary>
    [JsonProperty("viewMatched")]
    [JsonPropertyName("viewMatched")]
    public Dictionary<string, string> ViewMatched { get; set; } = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// True when a prefs file exists for this user (response-only; cleared before disk write).
    /// </summary>
    [JsonProperty("stored", NullValueHandling = NullValueHandling.Ignore)]
    [JsonPropertyName("stored")]
    [System.Text.Json.Serialization.JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public bool? Stored { get; set; }
}
