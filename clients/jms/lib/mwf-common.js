/**
 * Shared helpers for MWF Jellyfin Web extension (mirrors clients/jmp/mwf_mute.lua).
 */
(function (global) {
  const HEX = "[0-9a-fA-F]";
  const GUID_DASHED =
    HEX.repeat(8) +
    "-" +
    HEX.repeat(4) +
    "-" +
    HEX.repeat(4) +
    "-" +
    HEX.repeat(4) +
    "-" +
    HEX.repeat(12);
  const GUID_FLAT = HEX.repeat(32);

  /**
   * High-trust patterns only. Do NOT match MediaSourceId / PlaySessionId / bare GUIDs —
   * those flip between versions/sessions and are not the MWF store key.
   */
  const TRUSTED_PATTERNS = [
    { re: new RegExp("[?&#]ItemId=(" + GUID_DASHED + ")", "i"), label: "ItemId" },
    { re: new RegExp("[?&#]ItemId=(" + GUID_FLAT + ")", "i"), label: "ItemId" },
    { re: new RegExp("[?&#]itemId=(" + GUID_DASHED + ")", "i"), label: "itemId" },
    { re: new RegExp("[?&#]itemId=(" + GUID_FLAT + ")", "i"), label: "itemId" },
    { re: new RegExp("[?&#]item_id=(" + GUID_DASHED + ")", "i"), label: "item_id" },
    { re: new RegExp("[?&#]item_id=(" + GUID_FLAT + ")", "i"), label: "item_id" },
    { re: new RegExp("/Items/(" + GUID_DASHED + ")", "i"), label: "Items/" },
    { re: new RegExp("/Items/(" + GUID_FLAT + ")", "i"), label: "Items/" },
    // Jellyfin stream path is normally /Videos/{itemId}/… (item id, not MediaSourceId)
    { re: new RegExp("/Videos/(" + GUID_DASHED + ")", "i"), label: "Videos/" },
    { re: new RegExp("/Videos/(" + GUID_FLAT + ")", "i"), label: "Videos/" },
    { re: new RegExp("/Audio/(" + GUID_DASHED + ")", "i"), label: "Audio/" },
    { re: new RegExp("/Audio/(" + GUID_FLAT + ")", "i"), label: "Audio/" },
    // Hash routes: #/details?id= / #/video?id= / #/item?id=
    {
      re: new RegExp(
        "#/(?:details|item|video|movies|tv)[^#]*[?&]id=(" + GUID_DASHED + ")",
        "i",
      ),
      label: "hash-id",
    },
    {
      re: new RegExp(
        "#/(?:details|item|video|movies|tv)[^#]*[?&]id=(" + GUID_FLAT + ")",
        "i",
      ),
      label: "hash-id",
    },
  ];

  const DEFAULT_CONFIG = {
    enabled: true,
    apiBase: "http://127.0.0.1:8787",
    userIdOverride: "",
    itemIdOverride: "",
    pollIntervalMs: 100,
    debug: false,
  };

  function trimSlash(s) {
    return String(s || "").replace(/\/+$/, "");
  }

  function urlDecode(s) {
    if (!s) return s;
    try {
      return decodeURIComponent(String(s).replace(/\+/g, " "));
    } catch (_) {
      return String(s).replace(/\+/g, " ");
    }
  }

  /** Normalize Jellyfin ids to lowercase undashed 32-hex (matches MWF store). */
  function normalizeItemId(id) {
    if (!id) return null;
    const flat = String(id).replace(/\s+/g, "").replace(/-/g, "").toLowerCase();
    if (flat.length === 32 && /^[0-9a-f]+$/.test(flat)) {
      return flat;
    }
    return null;
  }

  /**
   * Extract a trusted Jellyfin *item* id from a URL/path string.
   * Never returns MediaSourceId / PlaySessionId / arbitrary bare GUIDs.
   */
  function extractFromString(s) {
    if (!s) return null;
    const text = urlDecode(String(s));

    for (const { re, label } of TRUSTED_PATTERNS) {
      const m = text.match(re);
      if (m && m[1]) {
        const norm = normalizeItemId(m[1]);
        if (norm) return { id: norm, raw: m[1], label };
      }
    }

    return null;
  }

  /** Half-open interval: start_ms <= t < end_ms (same as Lua mpv script). */
  function inMuteRange(tMs, ranges) {
    for (const r of ranges) {
      if (tMs >= r.start_ms && tMs < r.end_ms) {
        return true;
      }
    }
    return false;
  }

  function parseMuteDocument(data) {
    const list = data && Array.isArray(data.mutes) ? data.mutes : [];
    const mutes = [];
    for (const m of list) {
      const start_ms = Number(m.start_ms);
      const end_ms = Number(m.end_ms);
      if (Number.isFinite(start_ms) && Number.isFinite(end_ms)) {
        mutes.push({ start_ms, end_ms });
      }
    }
    return mutes;
  }

  function playbackMs(video) {
    if (!video) return 0;
    const t = Number(video.currentTime);
    if (!Number.isFinite(t)) return 0;
    return Math.round(t * 1000);
  }

  function mergeConfig(stored) {
    const out = { ...DEFAULT_CONFIG };
    if (stored && typeof stored === "object") {
      for (const key of Object.keys(DEFAULT_CONFIG)) {
        if (stored[key] !== undefined) {
          out[key] = stored[key];
        }
      }
    }
    out.apiBase = trimSlash(out.apiBase);
    out.pollIntervalMs = Math.max(50, Number(out.pollIntervalMs) || 100);
    return out;
  }

  global.MwfCommon = {
    DEFAULT_CONFIG,
    trimSlash,
    normalizeItemId,
    extractFromString,
    inMuteRange,
    parseMuteDocument,
    playbackMs,
    mergeConfig,
  };
})(typeof globalThis !== "undefined" ? globalThis : window);
