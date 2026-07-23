/**
 * Jellyfin Web content script — detect playback, fetch mutes via background, mute <video>.
 */
(function () {
  const ext = globalThis.browser ?? globalThis.chrome;
  const {
    mergeConfig,
    normalizeItemId,
    extractFromString,
    inMuteRange,
    playbackMs,
  } = MwfCommon;

  if (!isLikelyJellyfinPage()) {
    return;
  }

  const BRIDGE_SOURCE = "mwf-jms-bridge";

  const state = {
    config: mergeConfig(null),
    enabled: true,
    itemId: null,
    itemIdRaw: null,
    itemSource: null,
    userId: null,
    mutes: [],
    weMuted: false,
    userWasMuted: false,
    lastFingerprint: null,
    fetchPending: false,
    lastError: null,
    video: null,
    pollTimer: null,
    statusTimer: null,
    /** Latest MAIN-world bridge snapshot (PlaybackManager / ApiClient). */
    bridge: { itemId: null, itemSource: null, userId: null, at: 0 },
  };

  init();

  async function init() {
    state.config = mergeConfig(await loadConfig());
    state.enabled = state.config.enabled !== false;
    listenBridge();
    injectBridge();
    hookHistory();
    observeDom();
    startPolling();
    ext.storage.onChanged.addListener(onStorageChanged);
    log("content script loaded");
    tick(true);
  }

  function storageGet(area, key) {
    return new Promise((resolve) => {
      try {
        ext.storage[area].get(key, (data) => {
          if (ext.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(data?.[key] ?? null);
        });
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function loadConfig() {
    const fromSync = await storageGet("sync", "mwfConfig");
    if (fromSync) return fromSync;
    return storageGet("local", "mwfConfig");
  }

  function onStorageChanged(changes, area) {
    if (area !== "sync" && area !== "local") return;
    if (changes.mwfConfig) {
      state.config = mergeConfig(changes.mwfConfig.newValue);
      state.enabled = state.config.enabled !== false;
      state.lastFingerprint = null;
      startPolling();
      tick(true);
    }
  }

  function isLikelyJellyfinPage() {
    try {
      if (localStorage.getItem("jellyfin_credentials")) return true;
      if (sessionStorage.getItem("jellyfin_credentials")) return true;
    } catch (_) {}
    const href = location.href.toLowerCase();
    if (href.includes("jellyfin")) return true;
    if (document.querySelector('meta[name="application-name"][content*="Jellyfin" i]')) {
      return true;
    }
    // Hash routes used by jellyfin-web (#/home, #/details, #/video, …)
    if (/#\/(home|details|item|video|movies|tv|playback)/i.test(location.hash)) {
      return true;
    }
    return false;
  }

  function injectBridge() {
    if (document.documentElement.dataset.mwfJmsBridge === "1") return;
    document.documentElement.dataset.mwfJmsBridge = "1";
    const s = document.createElement("script");
    s.src = ext.runtime.getURL("page-bridge.js");
    s.async = false;
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  }

  function listenBridge() {
    window.addEventListener("message", (ev) => {
      if (ev.source !== window) return;
      const data = ev.data;
      if (!data || data.source !== BRIDGE_SOURCE || data.type !== "mwf-playback") return;
      state.bridge = {
        itemId: data.itemId || null,
        itemSource: data.itemSource || null,
        userId: data.userId || null,
        at: data.at || Date.now(),
      };
    });
  }

  function requestBridgeSnapshot() {
    window.postMessage({ source: "mwf-jms-content", type: "mwf-request" }, "*");
  }

  function hookHistory() {
    const fire = () => {
      state.lastFingerprint = null;
      requestBridgeSnapshot();
      tick(true);
    };
    const wrap = (fn) =>
      function (...args) {
        const ret = fn.apply(this, args);
        fire();
        return ret;
      };
    history.pushState = wrap(history.pushState);
    history.replaceState = wrap(history.replaceState);
    window.addEventListener("popstate", fire);
    window.addEventListener("hashchange", fire);
  }

  function observeDom() {
    const observer = new MutationObserver(() => {
      const video = findVideo();
      if (video !== state.video) {
        state.video = video;
        state.lastFingerprint = null;
        requestBridgeSnapshot();
        tick(true);
      }
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function startPolling() {
    if (state.pollTimer) clearInterval(state.pollTimer);
    const interval = Math.max(50, Number(state.config.pollIntervalMs) || 100);
    state.pollTimer = setInterval(() => tick(false), interval);
    if (state.statusTimer) clearInterval(state.statusTimer);
    state.statusTimer = setInterval(publishStatus, 1000);
  }

  function findVideo() {
    const videos = document.querySelectorAll("video");
    for (const v of videos) {
      if (!v.paused && !v.ended) return v;
    }
    for (const v of videos) {
      if (!v.ended) return v;
    }
    return videos[0] || null;
  }

  function userIdFromCredentials() {
    try {
      for (const store of [localStorage, sessionStorage]) {
        const raw = store.getItem("jellyfin_credentials");
        if (!raw) continue;
        const parsed = JSON.parse(raw);
        const servers = parsed?.Servers || parsed?.servers;
        if (Array.isArray(servers)) {
          for (const s of servers) {
            const uid = s?.UserId || s?.userId;
            if (uid) return uid;
          }
        }
        if (parsed?.UserId || parsed?.userId) {
          return parsed.UserId || parsed.userId;
        }
      }
    } catch (_) {}
    return null;
  }

  function resolveUserId() {
    const override = (state.config.userIdOverride || "").trim();
    if (override) return override;
    if (state.bridge.userId) return state.bridge.userId;
    return userIdFromCredentials();
  }

  /**
   * Discovery order: override → MAIN bridge → sticky last id (while video plays) →
   * trusted URL patterns only (never MediaSourceId / bare GUIDs).
   */
  function resolveItemId() {
    const manual = (state.config.itemIdOverride || "").trim();
    if (manual) {
      const norm = normalizeItemId(manual);
      if (norm) return { id: norm, raw: manual, source: "manual" };
    }

    if (state.bridge.itemId) {
      const norm = normalizeItemId(state.bridge.itemId);
      if (norm) {
        return {
          id: norm,
          raw: state.bridge.itemId,
          source: state.bridge.itemSource || "bridge",
        };
      }
    }

    // Keep the last good item id while a video is still present — stream URL /
    // SPA hash churn must not pick a different MediaSourceId or random GUID.
    const video = state.video || findVideo();
    if (video && state.itemId && state.itemSource !== "manual") {
      return {
        id: state.itemId,
        raw: state.itemIdRaw || state.itemId,
        source: state.itemSource || "sticky",
      };
    }

    if (video?.src) {
      const fromSrc = extractFromString(video.src);
      if (fromSrc) return { ...fromSrc, source: "video.src" };
    }
    if (video?.currentSrc) {
      const fromCurrent = extractFromString(video.currentSrc);
      if (fromCurrent) return { ...fromCurrent, source: "video.currentSrc" };
    }

    // Prefer hash routes (#/details?id=) over full href (fewer false hits).
    for (const src of [location.hash, location.href]) {
      const fromUrl = extractFromString(src);
      if (fromUrl) return { ...fromUrl, source: "url" };
    }

    return null;
  }

  /** Identity for mute reload — must NOT include volatile stream tokens / src. */
  function playbackIdentity() {
    const manual = (state.config.itemIdOverride || "").trim();
    if (manual) {
      return "manual:" + (normalizeItemId(manual) || manual);
    }
    if (state.bridge.itemId) {
      const norm = normalizeItemId(state.bridge.itemId);
      if (norm) return "bridge:" + norm;
    }
    if (state.itemId) return "sticky:" + state.itemId;
    return "none";
  }

  function refreshItemIfNeeded(force) {
    const identity = playbackIdentity();
    const resolved = resolveItemId();
    const newId = resolved?.id ?? null;

    if (!force && newId && newId === state.itemId && identity === state.lastFingerprint) {
      return;
    }

    // Same item, identity string changed only because sticky↔bridge — keep mutes.
    if (!force && newId && newId === state.itemId) {
      state.lastFingerprint = identity;
      state.itemSource = resolved?.source || state.itemSource;
      state.itemIdRaw = resolved?.raw || state.itemIdRaw;
      return;
    }

    state.lastFingerprint = identity;
    applyMute(false);
    state.mutes = [];
    state.userId = resolveUserId();

    state.itemId = newId;
    state.itemIdRaw = resolved?.raw ?? null;
    state.itemSource = resolved?.source ?? null;

    if (state.itemId) {
      state.lastError = null;
      log(`item id ${state.itemId} via ${state.itemSource}`);
      fetchMutes(state.itemId);
    } else {
      state.lastError = "could not resolve Jellyfin item id";
      log("no item id resolved");
    }
  }

  function fetchMutes(itemId) {
    if (state.fetchPending) return;
    state.fetchPending = true;

    ext.runtime.sendMessage(
      {
        type: "MWF_FETCH_MUTES",
        apiBase: state.config.apiBase,
        itemId,
        userId: state.userId || undefined,
      },
      (response) => {
        state.fetchPending = false;
        if (ext.runtime.lastError) {
          state.lastError = ext.runtime.lastError.message;
          state.mutes = [];
          publishStatus();
          return;
        }
        onMutesFetched(response);
      },
    );
  }

  function onMutesFetched(response) {
    if (!response?.ok) {
      state.lastError = response?.error || "fetch failed";
      state.mutes = [];
      publishStatus();
      return;
    }
    if (response.status === 404) {
      state.lastError = response.error || "no mute data";
      state.mutes = [];
      publishStatus();
      return;
    }
    state.mutes = response.mutes || [];
    state.lastError = state.mutes.length === 0 ? "API returned 0 mute ranges" : null;
    log(`loaded ${state.mutes.length} mute range(s) for ${state.itemId}`);
    publishStatus();
  }

  function applyMute(want) {
    const video = state.video || findVideo();
    if (!video) {
      state.weMuted = false;
      return;
    }

    if (want) {
      if (!state.weMuted) {
        state.userWasMuted = video.muted;
        video.muted = true;
        state.weMuted = true;
        log("mute on");
      } else if (!video.muted) {
        video.muted = true;
      }
      return;
    }

    if (state.weMuted) {
      video.muted = state.userWasMuted;
      state.weMuted = false;
      log("mute off");
    }
  }

  function tick(force) {
    const prevVideo = state.video;
    state.video = findVideo() || null;
    // Playback ended / player closed — drop sticky item so the next title resolves fresh.
    if (prevVideo && !state.video) {
      applyMute(false);
      state.itemId = null;
      state.itemIdRaw = null;
      state.itemSource = null;
      state.mutes = [];
      state.lastFingerprint = null;
    }
    if (!state.enabled) {
      applyMute(false);
      publishStatus();
      return;
    }
    refreshItemIfNeeded(force);
    if (!state.itemId || state.mutes.length === 0) {
      applyMute(false);
      publishStatus();
      return;
    }
    const tMs = playbackMs(state.video);
    applyMute(inMuteRange(tMs, state.mutes));
    publishStatus();
  }

  function publishStatus() {
    const status = {
      enabled: state.enabled,
      connected: !state.lastError || state.mutes.length > 0,
      apiBase: state.config.apiBase,
      userId: state.userId || "(auto)",
      itemId: state.itemId,
      itemIdRaw: state.itemIdRaw,
      itemSource: state.itemSource,
      muteCount: state.mutes.length,
      currentlyMuted: state.weMuted,
      lastError: state.lastError,
      pageUrl: location.href,
      updatedAt: Date.now(),
    };

    ext.storage.local.set({ mwfStatus: status });

    let badge = { text: "" };
    if (state.weMuted) {
      badge = { text: "M", color: "#b00020" };
    } else if (state.itemId && state.mutes.length > 0) {
      badge = { text: String(state.mutes.length), color: "#00695c" };
    }
    ext.runtime.sendMessage({ type: "MWF_SET_BADGE", ...badge }, () => {
      void ext.runtime.lastError;
    });
  }

  function log(...args) {
    if (state.config.debug) {
      console.log("[mwf-jms]", ...args);
    }
  }
})();
