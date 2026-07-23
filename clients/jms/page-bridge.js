/**
 * Runs in the page MAIN world so Jellyfin globals (PlaybackManager, ApiClient) are visible.
 * Posts snapshots to the isolated content script via window.postMessage.
 *
 * Always reports PlaybackManager/ApiClient *item* Id — never MediaSourceId.
 */
(function () {
  if (window.__mwfJmsBridge) return;
  window.__mwfJmsBridge = true;

  const SOURCE = "mwf-jms-bridge";

  function getApiClient() {
    if (window.ApiClient) return window.ApiClient;
    if (window.jellyfin && window.jellyfin.ApiClient) return window.jellyfin.ApiClient;
    return null;
  }

  function getPlaybackManager() {
    if (window.PlaybackManager) return window.PlaybackManager;
    if (window.jellyfin && window.jellyfin.PlaybackManager) {
      return window.jellyfin.PlaybackManager;
    }
    return null;
  }

  function currentItem() {
    const pm = getPlaybackManager();
    if (!pm) return null;
    try {
      if (typeof pm.currentItem === "function") return pm.currentItem();
      if (typeof pm.getCurrentItem === "function") return pm.getCurrentItem();
      if (typeof pm.getCurrentlyPlayingItem === "function") {
        return pm.getCurrentlyPlayingItem();
      }
      if (pm._currentItem) return pm._currentItem;
      if (pm.currentItem) return pm.currentItem;
    } catch (_) {}
    return null;
  }

  function itemIdFromPlayerState() {
    const pm = getPlaybackManager();
    if (!pm) return null;
    try {
      const state =
        typeof pm.getPlayerState === "function"
          ? pm.getPlayerState()
          : typeof pm.getCurrentPlayerState === "function"
            ? pm.getCurrentPlayerState()
            : null;
      const now = state && (state.NowPlayingItem || state.nowPlayingItem);
      if (now && now.Id) return String(now.Id);
    } catch (_) {}
    return null;
  }

  function snapshot() {
    let itemId = null;
    let itemSource = null;
    let userId = null;

    const item = currentItem();
    if (item && item.Id) {
      itemId = String(item.Id);
      itemSource = "PlaybackManager.currentItem";
    }

    if (!itemId) {
      const fromState = itemIdFromPlayerState();
      if (fromState) {
        itemId = fromState;
        itemSource = "PlaybackManager.playerState";
      }
    }

    const client = getApiClient();
    if (!itemId && client && typeof client.getCurrentItemId === "function") {
      try {
        const id = client.getCurrentItemId();
        if (id) {
          itemId = String(id);
          itemSource = "ApiClient.getCurrentItemId";
        }
      } catch (_) {}
    }

    if (client && typeof client.getCurrentUserId === "function") {
      try {
        const uid = client.getCurrentUserId();
        if (uid) userId = String(uid);
      } catch (_) {}
    }

    window.postMessage(
      {
        source: SOURCE,
        type: "mwf-playback",
        itemId,
        itemSource,
        userId,
        href: location.href,
        at: Date.now(),
      },
      "*",
    );
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== "mwf-jms-content" || data.type !== "mwf-request") return;
    snapshot();
  });

  snapshot();
  setInterval(snapshot, 500);
})();
