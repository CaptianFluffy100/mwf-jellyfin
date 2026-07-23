using System.Collections;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Jellyfin.Plugin.MediaWordFilter.Web;

/// <summary>
/// Shared helpers for injecting the MWF client script into jellyfin-web index.html.
/// </summary>
public static class ClientScriptInjection
{
    /// <summary>
    /// Plugin version string used in the injected script URL cache-buster.
    /// </summary>
    public const string PluginVersion = "1.0.11.0";

    private const string Marker = "data-mwf-plugin=\"1\"";
    private static readonly HashSet<string> LoggedPayloadShapes = new(StringComparer.Ordinal);

    /// <summary>
    /// Builds the script tag injected into index.html.
    /// </summary>
    /// <returns>HTML script element.</returns>
    public static string BuildScriptTag()
    {
        return "<script defer src=\"/MediaWordFilter/ClientScript?v=" + PluginVersion + "\" " + Marker + "></script>";
    }

    /// <summary>
    /// Returns true when the response body looks like jellyfin-web index.html.
    /// </summary>
    /// <param name="contents">Candidate HTML.</param>
    /// <returns>True if safe to patch.</returns>
    public static bool LooksLikeHtml(string contents)
    {
        if (string.IsNullOrWhiteSpace(contents))
        {
            return false;
        }

        var trimmed = contents.AsSpan().TrimStart();
        if (trimmed.StartsWith("\uFEFF", StringComparison.Ordinal))
        {
            trimmed = trimmed.Slice(1).TrimStart();
        }

        if (trimmed.StartsWith("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("<!doctype", StringComparison.OrdinalIgnoreCase)
            || trimmed.StartsWith("<html", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return contents.Contains("<html", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<!DOCTYPE", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<!doctype", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("</body>", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<head", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<body", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("id=\"root\"", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("id='root'", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("reactRoot", StringComparison.OrdinalIgnoreCase)
            || contents.Contains("<meta", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Injects the client script tag into HTML when not already present.
    /// </summary>
    /// <param name="html">Original HTML.</param>
    /// <returns>Patched HTML.</returns>
    public static string InjectIntoHtml(string html)
    {
        if (html.Contains(Marker, StringComparison.Ordinal)
            || html.Contains("/MediaWordFilter/ClientScript", StringComparison.OrdinalIgnoreCase))
        {
            return html;
        }

        html = Regex.Replace(
            html,
            "<script[^>]*MediaWordFilter/ClientScript[^>]*>\\s*</script>\\s*",
            string.Empty,
            RegexOptions.IgnoreCase);

        var scriptTag = BuildScriptTag();

        if (html.Contains("</body>", StringComparison.OrdinalIgnoreCase))
        {
            return html.Replace("</body>", scriptTag + "\n</body>", StringComparison.OrdinalIgnoreCase);
        }

        if (html.Contains("</html>", StringComparison.OrdinalIgnoreCase))
        {
            return html.Replace("</html>", scriptTag + "\n</html>", StringComparison.OrdinalIgnoreCase);
        }

        return html + "\n" + scriptTag + "\n";
    }

    /// <summary>
    /// File Transformation callback for index.html.
    /// </summary>
    /// <param name="input">Payload from File Transformation.</param>
    /// <param name="logger">Optional logger.</param>
    /// <returns>Patched HTML, or the original HTML if patching cannot be done safely.</returns>
    public static string TransformIndexHtml(object? input, ILogger? logger = null)
    {
        if (!TryExtractHtmlContents(input, out var contents, out var shape, logger))
        {
            logger?.LogError(
                "Media Word Filter index.html transform: could not extract HTML from payload type {Type}; skipping patch",
                input?.GetType().FullName ?? "null");

            if (input is string raw && raw.Length > 0)
            {
                return raw;
            }

            throw new InvalidOperationException(
                "Media Word Filter index.html transform: no HTML contents in payload; refusing to return empty HTML.");
        }

        if (!LooksLikeHtml(contents))
        {
            LogPayloadShapeOnce(
                logger,
                shape,
                "non-html",
                input,
                contents,
                "Media Word Filter index.html transform: payload does not look like HTML; skipping patch");
            return contents;
        }

        return InjectIntoHtml(contents);
    }

    /// <summary>
    /// True when the request path is the jellyfin-web shell document.
    /// </summary>
    /// <param name="path">Request path.</param>
    /// <returns>True for web index routes.</returns>
    public static bool IsWebIndexRequest(string? path)
    {
        if (string.IsNullOrEmpty(path))
        {
            return false;
        }

        return path.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
            || path.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
            || path.Equals("/web", StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryExtractHtmlContents(
        object? input,
        out string contents,
        out string shape,
        ILogger? logger)
    {
        contents = string.Empty;
        shape = input?.GetType().FullName ?? "null";

        if (input is null)
        {
            return false;
        }

        if (input is string s)
        {
            if (TryDecodeWrappedContents(s, out contents))
            {
                shape = "string(wrapped)";
                return contents.Length > 0;
            }

            contents = s;
            shape = "string(raw)";
            return contents.Length > 0;
        }

        if (input is byte[] bytes)
        {
            contents = Encoding.UTF8.GetString(bytes);
            shape = "byte[]";
            return contents.Length > 0;
        }

        if (input is PatchRequestPayload payload && !string.IsNullOrEmpty(payload.Contents))
        {
            contents = payload.Contents;
            shape = nameof(PatchRequestPayload);
            return true;
        }

        if (input is JObject jobj)
        {
            shape = DescribeJObjectShape(jobj);
            if (TryExtractFromJToken(jobj, out contents))
            {
                return contents.Length > 0;
            }
        }

        if (input is JToken token)
        {
            shape = DescribeJTokenShape(token);
            if (TryExtractFromJToken(token, out contents))
            {
                return contents.Length > 0;
            }
        }

        if (input is JsonElement element)
        {
            shape = "JsonElement:" + element.ValueKind;
            if (TryExtractFromJsonElement(element, out contents))
            {
                return contents.Length > 0;
            }
        }

        if (input is IDictionary dict)
        {
            shape = "IDictionary:" + dict.GetType().Name;
            if (TryExtractFromDictionary(dict, out contents))
            {
                return contents.Length > 0;
            }
        }

        foreach (var prop in input.GetType().GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!IsContentsPropertyName(prop.Name))
            {
                continue;
            }

            var value = prop.GetValue(input);
            if (TryCoerceToHtmlString(value, out contents))
            {
                shape = input.GetType().Name + "." + prop.Name;
                return contents.Length > 0;
            }
        }

        LogPayloadShapeOnce(
            logger,
            shape,
            "extract-fail",
            input,
            null,
            "Media Word Filter index.html transform: unrecognized payload shape");

        return false;
    }

    private static bool TryExtractFromJToken(JToken token, out string contents)
    {
        contents = string.Empty;

        if (token.Type == JTokenType.String)
        {
            contents = token.ToString();
            return contents.Length > 0;
        }

        if (token is JObject obj)
        {
            foreach (var key in ContentsKeys)
            {
                var child = obj[key];
                if (child is null)
                {
                    continue;
                }

                if (TryCoerceToHtmlString(child, out contents))
                {
                    return contents.Length > 0;
                }
            }

            var nested = obj["TransformationPayload"] ?? obj["transformationPayload"] ?? obj["payload"] ?? obj["Payload"];
            if (nested is not null && TryExtractFromJToken(nested, out contents))
            {
                return contents.Length > 0;
            }
        }

        return false;
    }

    private static bool TryExtractFromJsonElement(JsonElement element, out string contents)
    {
        contents = string.Empty;

        if (element.ValueKind == JsonValueKind.String)
        {
            contents = element.GetString() ?? string.Empty;
            return TryDecodeWrappedContents(contents, out contents) || contents.Length > 0;
        }

        if (element.ValueKind == JsonValueKind.Object)
        {
            foreach (var key in ContentsKeys)
            {
                if (element.TryGetProperty(key, out var child) && TryExtractFromJsonElement(child, out contents))
                {
                    return contents.Length > 0;
                }
            }
        }

        return false;
    }

    private static bool TryExtractFromDictionary(IDictionary dict, out string contents)
    {
        contents = string.Empty;

        foreach (var key in ContentsKeys)
        {
            if (!dict.Contains(key))
            {
                continue;
            }

            if (TryCoerceToHtmlString(dict[key], out contents))
            {
                return contents.Length > 0;
            }
        }

        foreach (var wrapperKey in new[] { "TransformationPayload", "transformationPayload", "payload", "Payload" })
        {
            if (!dict.Contains(wrapperKey))
            {
                continue;
            }

            if (dict[wrapperKey] is IDictionary nested && TryExtractFromDictionary(nested, out contents))
            {
                return contents.Length > 0;
            }

            if (TryCoerceToHtmlString(dict[wrapperKey], out contents))
            {
                return contents.Length > 0;
            }
        }

        return false;
    }

    private static bool TryCoerceToHtmlString(object? value, out string contents)
    {
        contents = string.Empty;

        if (value is null)
        {
            return false;
        }

        if (value is string s)
        {
            if (TryDecodeWrappedContents(s, out contents))
            {
                return contents.Length > 0;
            }

            contents = s;
            return contents.Length > 0;
        }

        if (value is byte[] bytes)
        {
            contents = Encoding.UTF8.GetString(bytes);
            return contents.Length > 0;
        }

        if (value is JValue jValue && jValue.Type == JTokenType.String)
        {
            contents = jValue.ToString();
            return TryDecodeWrappedContents(contents, out contents) || contents.Length > 0;
        }

        if (value is JToken jToken && TryExtractFromJToken(jToken, out contents))
        {
            return contents.Length > 0;
        }

        if (value is JsonElement element && TryExtractFromJsonElement(element, out contents))
        {
            return contents.Length > 0;
        }

        return false;
    }

    private static bool TryDecodeWrappedContents(string candidate, out string contents)
    {
        contents = candidate;

        if (string.IsNullOrWhiteSpace(candidate))
        {
            return false;
        }

        var trimmed = candidate.TrimStart();
        if (trimmed.StartsWith('{') && trimmed.Contains("\"contents\"", StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                var token = JToken.Parse(trimmed);
                if (TryExtractFromJToken(token, out var nested) && nested.Length > 0)
                {
                    contents = nested;
                    return true;
                }
            }
            catch
            {
                // Not JSON — treat as raw HTML below.
            }
        }

        if (LooksLikeBase64(trimmed) && TryDecodeBase64Html(trimmed, out var decoded))
        {
            contents = decoded;
            return true;
        }

        return false;
    }

    private static bool LooksLikeBase64(ReadOnlySpan<char> value)
    {
        if (value.Length < 16 || (value.Length % 4) != 0)
        {
            return false;
        }

        foreach (var ch in value)
        {
            if (char.IsLetterOrDigit(ch) || ch is '+' or '/' or '=')
            {
                continue;
            }

            return false;
        }

        return true;
    }

    private static bool TryDecodeBase64Html(string value, out string contents)
    {
        contents = string.Empty;
        try
        {
            var bytes = Convert.FromBase64String(value);
            contents = Encoding.UTF8.GetString(bytes);
            return LooksLikeHtml(contents);
        }
        catch
        {
            return false;
        }
    }

    private static string DescribeJObjectShape(JObject obj)
    {
        var keys = obj.Properties().Select(p => p.Name).Take(8);
        return "JObject{" + string.Join(",", keys) + "}";
    }

    private static string DescribeJTokenShape(JToken token)
    {
        return token.Type switch
        {
            JTokenType.Object => DescribeJObjectShape((JObject)token),
            _ => "JToken:" + token.Type
        };
    }

    private static bool IsContentsPropertyName(string name)
    {
        return name.Equals("contents", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Contents", StringComparison.OrdinalIgnoreCase)
            || name.Equals("content", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Content", StringComparison.OrdinalIgnoreCase)
            || name.Equals("html", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Html", StringComparison.OrdinalIgnoreCase)
            || name.Equals("body", StringComparison.OrdinalIgnoreCase)
            || name.Equals("Body", StringComparison.OrdinalIgnoreCase);
    }

    private static readonly string[] ContentsKeys =
    {
        "contents",
        "Contents",
        "content",
        "Content",
        "html",
        "Html",
        "body",
        "Body"
    };

    private static void LogPayloadShapeOnce(
        ILogger? logger,
        string shape,
        string reason,
        object? input,
        string? contents,
        string message)
    {
        if (logger is null)
        {
            return;
        }

        var key = shape + "|" + reason;
        if (!LoggedPayloadShapes.Add(key))
        {
            return;
        }

        var prefix = contents is null ? "(null)" : Preview(contents);
        var jsonKeys = input switch
        {
            JObject jobj => string.Join(",", jobj.Properties().Select(p => p.Name).Take(12)),
            IDictionary dict => string.Join(",", dict.Keys.Cast<object>().Select(k => k.ToString()).Take(12)),
            _ => string.Empty
        };

        logger.LogWarning(
            "{Message} (shape={Shape}, runtimeType={Type}, jsonKeys={JsonKeys}, prefix={Prefix})",
            message,
            shape,
            input?.GetType().FullName ?? "null",
            string.IsNullOrEmpty(jsonKeys) ? "(none)" : jsonKeys,
            prefix);
    }

    private static string Preview(string value)
    {
        var normalized = value.Replace("\r", "\\r", StringComparison.Ordinal)
            .Replace("\n", "\\n", StringComparison.Ordinal);
        return normalized.Length <= 120 ? normalized : normalized[..120];
    }
}

/// <summary>
/// Payload shape that File Transformation may bind when using System.Text.Json.
/// </summary>
public sealed class PatchRequestPayload
{
    /// <summary>
    /// Gets or sets the current file contents.
    /// </summary>
    [JsonPropertyName("contents")]
    [Newtonsoft.Json.JsonProperty("contents")]
    public string? Contents { get; set; }
}
