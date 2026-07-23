/**
 * Media Word Filter — Jellyfin Web client (server plugin).
 * Mute via video.muted; profile/filter UI only on the details page.
 * Does NOT touch the playback OSD / media bar.
 */
(function () {
  if (window.__MWF_CLIENT_LOADED__) return;
  window.__MWF_CLIENT_LOADED__ = true;

  var FLAGS = window.__MWF_PLUGIN__ || {
    enableDetailsUi: true,
    enablePrefetch: true
  };

  var LS_ENABLED = "mwfFilterEnabled";
  var LS_PROFILE = "mwfProfileUserId";
  var POLL_MS = 100;

  var HEX = "[0-9a-fA-F]";
  var GUID_DASHED =
    HEX.repeat(8) +
    "-" +
    HEX.repeat(4) +
    "-" +
    HEX.repeat(4) +
    "-" +
    HEX.repeat(4) +
    "-" +
    HEX.repeat(12);
  var GUID_FLAT = HEX.repeat(32);

  var TRUSTED_PATTERNS = [
    { re: new RegExp("[?&#]ItemId=(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("[?&#]ItemId=(" + GUID_FLAT + ")", "i") },
    { re: new RegExp("[?&#]itemId=(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("[?&#]itemId=(" + GUID_FLAT + ")", "i") },
    { re: new RegExp("[?&#]item_id=(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("[?&#]item_id=(" + GUID_FLAT + ")", "i") },
    { re: new RegExp("/Items/(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("/Items/(" + GUID_FLAT + ")", "i") },
    { re: new RegExp("/Videos/(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("/Videos/(" + GUID_FLAT + ")", "i") },
    { re: new RegExp("/Audio/(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("/Audio/(" + GUID_FLAT + ")", "i") },
    {
      re: new RegExp(
        "#/(?:details|item|video|movies|tv)[^#]*[?&]id=(" + GUID_DASHED + ")",
        "i"
      )
    },
    {
      re: new RegExp(
        "#/(?:details|item|video|movies|tv)[^#]*[?&]id=(" + GUID_FLAT + ")",
        "i"
      )
    }
  ];

  var CLIENT_VERSION = "1.0.11.0";

  var state = {
    enabled: readEnabled(),
    profileUserId: readProfile(),
    profiles: [],
    profilesLoaded: false,
    itemId: null,
    itemIdSource: null,
    mutes: [],
    muteKey: null,
    weMuted: false,
    userWasMuted: false,
    video: null,
    cache: Object.create(null),
    fetchPending: Object.create(null),
    detailsMountedFor: null,
    playbackHooksAttached: false,
    warnOnceKeys: Object.create(null),
    lastTickDiag: null
  };

  function log() {
    if (!window.__MWF_DEBUG__) return;
    var args = ["[mwf-plugin]"].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
  }

  function warnOnce(key, message, detail) {
    if (state.warnOnceKeys[key]) return;
    state.warnOnceKeys[key] = true;
    var args = ["[mwf-plugin]", message];
    if (detail !== undefined && detail !== null) args.push(detail);
    console.warn.apply(console, args);
  }

  function readEnabled() {
    try {
      var v = localStorage.getItem(LS_ENABLED);
      if (v === null || v === undefined) return true;
      return v === "1" || v === "true";
    } catch (_) {
      return true;
    }
  }

  function writeEnabled(on) {
    state.enabled = !!on;
    try {
      localStorage.setItem(LS_ENABLED, state.enabled ? "1" : "0");
    } catch (_) {}
    syncUiControls();
    state.muteKey = null;
    ensureMutes(state.itemId, true);
  }

  function readProfile() {
    try {
      return localStorage.getItem(LS_PROFILE) || "";
    } catch (_) {
      return "";
    }
  }

  function writeProfile(id) {
    state.profileUserId = id || "";
    try {
      if (state.profileUserId) localStorage.setItem(LS_PROFILE, state.profileUserId);
      else localStorage.removeItem(LS_PROFILE);
    } catch (_) {}
    syncUiControls();
    state.muteKey = null;
    clearCache();
    ensureMutes(state.itemId, true);
  }

  function clearCache() {
    state.cache = Object.create(null);
  }

  function normalizeItemId(id) {
    if (!id) return null;
    var flat = String(id).replace(/\s+/g, "").replace(/-/g, "").toLowerCase();
    if (flat.length === 32 && /^[0-9a-f]+$/.test(flat)) return flat;
    return null;
  }

  function extractFromString(s) {
    if (!s) return null;
    var text = String(s);
    try {
      text = decodeURIComponent(text.replace(/\+/g, " "));
    } catch (_) {}
    for (var i = 0; i < TRUSTED_PATTERNS.length; i++) {
      var m = text.match(TRUSTED_PATTERNS[i].re);
      if (m && m[1]) {
        var norm = normalizeItemId(m[1]);
        if (norm) return norm;
      }
    }
    return null;
  }

  function inMuteRange(tMs, ranges) {
    for (var i = 0; i < ranges.length; i++) {
      var r = ranges[i];
      if (tMs >= r.start_ms && tMs < r.end_ms) return true;
    }
    return false;
  }

  function parseMuteDocument(data) {
    var list = data && Array.isArray(data.mutes) ? data.mutes : [];
    var mutes = [];
    for (var i = 0; i < list.length; i++) {
      var start_ms = Number(list[i].start_ms);
      var end_ms = Number(list[i].end_ms);
      if (Number.isFinite(start_ms) && Number.isFinite(end_ms)) {
        mutes.push({ start_ms: start_ms, end_ms: end_ms });
      }
    }
    return mutes;
  }

  function playbackMs(video) {
    if (!video) return 0;
    var t = Number(video.currentTime);
    if (!Number.isFinite(t)) return 0;
    return Math.round(t * 1000);
  }

  function apiClient() {
    if (window.ApiClient) return window.ApiClient;
    if (window.jellyfin && window.jellyfin.ApiClient) return window.jellyfin.ApiClient;
    return null;
  }

  function playbackManager() {
    if (window.PlaybackManager) return window.PlaybackManager;
    if (window.jellyfin && window.jellyfin.PlaybackManager) {
      return window.jellyfin.PlaybackManager;
    }
    return null;
  }

  function accessTokenFromCredentials() {
    try {
      for (var i = 0; i < 2; i++) {
        var store = i === 0 ? localStorage : sessionStorage;
        var raw = store.getItem("jellyfin_credentials");
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        var servers = parsed && (parsed.Servers || parsed.servers);
        if (Array.isArray(servers)) {
          for (var j = 0; j < servers.length; j++) {
            var tok = servers[j].AccessToken || servers[j].accessToken;
            if (tok) return tok;
          }
        }
        if (parsed && (parsed.AccessToken || parsed.accessToken)) {
          return parsed.AccessToken || parsed.accessToken;
        }
      }
    } catch (_) {}
    return null;
  }

  function authHeaders() {
    var c = apiClient();
    var headers = { Accept: "application/json" };
    var tok = null;
    try {
      if (c && typeof c.accessToken === "function") {
        tok = c.accessToken();
      }
    } catch (_) {}
    try {
      if (!tok && c && typeof c.getAccessToken === "function") {
        tok = c.getAccessToken();
      }
    } catch (_) {}
    if (!tok && c && (c.accessToken || c._accessToken)) {
      tok = c.accessToken || c._accessToken;
    }
    if (!tok) tok = accessTokenFromCredentials();
    if (tok) {
      headers["X-Emby-Token"] = tok;
      headers["Authorization"] = "MediaBrowser Token=" + tok + ", Client=\"Jellyfin Web\", Device=\"Browser\", DeviceId=\"mwf-plugin\", Version=\"" + CLIENT_VERSION + "\"";
    }
    return headers;
  }

  function hasAuthToken() {
    return !!authHeaders()["X-Emby-Token"];
  }

  function apiUrl(path) {
    var c = apiClient();
    if (c && typeof c.getUrl === "function") {
      return c.getUrl(path.replace(/^\//, ""));
    }
    var base = (c && c.serverAddress && c.serverAddress()) || location.origin;
    return String(base).replace(/\/+$/, "") + "/" + path.replace(/^\//, "");
  }

  function fetchJson(path, allowRetry) {
    return fetch(apiUrl(path), {
      credentials: "same-origin",
      headers: authHeaders()
    }).then(function (res) {
      if (res.status === 404) return null;
      if (res.status === 401) {
        if (allowRetry !== false && !hasAuthToken()) {
          warnOnce("auth-401:" + path, "request returned 401 before Jellyfin auth was ready: " + path);
        } else {
          warnOnce("auth-401:" + path, "request returned 401 (check Jellyfin login): " + path);
        }
        throw new Error("HTTP 401 unauthorized");
      }
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("HTTP " + res.status + " " + t);
        });
      }
      return res.json();
    });
  }

  function currentUserId() {
    var c = apiClient();
    try {
      if (c && typeof c.getCurrentUserId === "function") {
        var id = c.getCurrentUserId();
        if (id) return id;
      }
    } catch (_) {}
    try {
      for (var i = 0; i < 2; i++) {
        var store = i === 0 ? localStorage : sessionStorage;
        var raw = store.getItem("jellyfin_credentials");
        if (!raw) continue;
        var parsed = JSON.parse(raw);
        var servers = parsed && (parsed.Servers || parsed.servers);
        if (Array.isArray(servers)) {
          for (var j = 0; j < servers.length; j++) {
            var uid = servers[j].UserId || servers[j].userId;
            if (uid) return uid;
          }
        }
        if (parsed && (parsed.UserId || parsed.userId)) {
          return parsed.UserId || parsed.userId;
        }
      }
    } catch (_) {}
    return null;
  }

  function effectiveProfileUserId() {
    return state.profileUserId || currentUserId() || "";
  }

  function pmCurrentItem() {
    var pm = playbackManager();
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

  function pmItemIdFromPlayerState() {
    var pm = playbackManager();
    if (!pm) return null;
    try {
      var st =
        typeof pm.getPlayerState === "function"
          ? pm.getPlayerState()
          : typeof pm.getCurrentPlayerState === "function"
            ? pm.getCurrentPlayerState()
            : null;
      var now = st && (st.NowPlayingItem || st.nowPlayingItem);
      if (now && now.Id) return normalizeItemId(now.Id);
    } catch (_) {}
    return null;
  }

  /**
   * Resolve Jellyfin item Id (never MediaSourceId). Sticky while a video element exists.
   */
  function resolvePlaybackItemId(video) {
    var playing = video && !video.paused && !video.ended;

    if (video && state.itemId && (playing || state.muteKey === cacheKey(state.itemId))) {
      return { id: state.itemId, source: state.itemIdSource || "sticky-loaded" };
    }

    if (video && state.itemId) {
      return { id: state.itemId, source: state.itemIdSource || "sticky" };
    }

    var fromHash = extractFromString(location.hash);
    if (fromHash && /#\/(?:video|playback)/i.test(location.hash || "")) {
      return { id: fromHash, source: "hash-video" };
    }

    var item = pmCurrentItem();
    if (item && item.Id) {
      var fromPm = normalizeItemId(item.Id);
      if (fromPm) return { id: fromPm, source: "PlaybackManager.currentItem" };
    }

    var fromState = pmItemIdFromPlayerState();
    if (fromState) return { id: fromState, source: "PlaybackManager.playerState" };

    try {
      var pm = playbackManager();
      if (pm && typeof pm.getCurrentPlayer === "function") {
        var player = pm.getCurrentPlayer();
        if (player) {
          if (player._currentItem && player._currentItem.Id) {
            var fromPlayer = normalizeItemId(player._currentItem.Id);
            if (fromPlayer) return { id: fromPlayer, source: "player._currentItem" };
          }
          if (typeof player.getCurrentItem === "function") {
            var pit = player.getCurrentItem();
            if (pit && pit.Id) {
              var fromGet = normalizeItemId(pit.Id);
              if (fromGet) return { id: fromGet, source: "player.getCurrentItem" };
            }
          }
        }
      }
    } catch (_) {}

    try {
      var c = apiClient();
      if (c && typeof c.getCurrentItemId === "function") {
        var fromApi = normalizeItemId(c.getCurrentItemId());
        if (fromApi) return { id: fromApi, source: "ApiClient.getCurrentItemId" };
      }
    } catch (_) {}

    if (video && video.src) {
      var fromSrc = extractFromString(video.src);
      if (fromSrc) return { id: fromSrc, source: "video.src" };
    }
    if (video && video.currentSrc) {
      var fromCurrentSrc = extractFromString(video.currentSrc);
      if (fromCurrentSrc) return { id: fromCurrentSrc, source: "video.currentSrc" };
    }

    if (fromHash) return { id: fromHash, source: "hash" };
    var fromHref = extractFromString(location.href);
    if (fromHref) return { id: fromHref, source: "href" };

    return null;
  }

  function refreshPlaybackItem(video, force) {
    var prevVideo = state.video;

    if (prevVideo && !video) {
      if (state.weMuted) applyMute(prevVideo, false);
      state.video = null;
      state.itemId = null;
      state.itemIdSource = null;
      state.mutes = [];
      state.muteKey = null;
      return;
    }

    if (video) state.video = video;

    var resolved = resolvePlaybackItemId(video);
    var newId = resolved ? resolved.id : null;
    var newSource = resolved ? resolved.source : null;

    if (!force && newId && newId === state.itemId) {
      if (newSource && newSource !== "sticky") state.itemIdSource = newSource;
      return;
    }

    if (!force && !newId && video && state.itemId) {
      return;
    }

    if (!force && !newId && !video) {
      if (state.itemId) {
        state.itemId = null;
        state.itemIdSource = null;
        state.mutes = [];
        state.muteKey = null;
      }
      return;
    }

    if (newId !== state.itemId) {
      if (state.weMuted && video) applyMute(video, false);
      state.itemId = newId;
      state.itemIdSource = newSource;
      state.muteKey = null;
      if (newId) {
        log("item id", newId, "via", newSource);
        ensureMutes(newId, false).then(function () {
          prefetchNextEpisode(newId);
        });
      } else {
        state.mutes = [];
      }
    }
  }

  function findVideo() {
    var selectors = [
      ".videoPlayerContainer-onTop video.htmlvideoplayer",
      ".videoPlayerContainer-onTop video",
      ".videoPlayerContainer video.htmlvideoplayer",
      ".videoPlayerContainer video",
      "#videoPlayer video",
      "video.htmlvideoplayer"
    ];
    for (var s = 0; s < selectors.length; s++) {
      var preferred = document.querySelector(selectors[s]);
      if (preferred && !preferred.ended) return preferred;
    }

    var videos = document.querySelectorAll("video");
    for (var i = 0; i < videos.length; i++) {
      if (!videos[i].paused && !videos[i].ended) return videos[i];
    }
    for (var j = 0; j < videos.length; j++) {
      if (!videos[j].ended) return videos[j];
    }
    return videos[0] || null;
  }

  function cacheKey(itemId) {
    return (itemId || "") + "|" + (effectiveProfileUserId() || "");
  }

  function ensureMutes(itemId, force) {
    if (!itemId) {
      state.mutes = [];
      state.muteKey = null;
      return Promise.resolve([]);
    }
    if (!state.enabled) {
      state.mutes = [];
      state.muteKey = cacheKey(itemId) + "|off";
      return Promise.resolve([]);
    }

    var key = cacheKey(itemId);
    if (!force && state.muteKey === key && state.cache[key]) {
      state.mutes = state.cache[key].mutes;
      return Promise.resolve(state.mutes);
    }
    if (state.cache[key] && !force) {
      state.mutes = state.cache[key].mutes;
      state.muteKey = key;
      return Promise.resolve(state.mutes);
    }
    if (state.fetchPending[key] && !force) {
      return state.fetchPending[key];
    }

    if (!hasAuthToken()) {
      warnOnce("no-auth", "mute fetch waiting for Jellyfin auth token (ApiClient or jellyfin_credentials)");
      state.muteKey = null;
      return Promise.resolve(state.mutes || []);
    }

    var uid = effectiveProfileUserId();
    var path = "MediaWordFilter/mutes/" + encodeURIComponent(itemId);
    if (uid) path += "?user_id=" + encodeURIComponent(uid);

    var p = fetchJson(path)
      .then(function (doc) {
        var mutes = doc ? parseMuteDocument(doc) : [];
        state.cache[key] = { mutes: mutes, fetchedAt: Date.now() };
        state.mutes = mutes;
        state.muteKey = key;
        delete state.warnOnceKeys["auth-401:" + path];
        log("loaded", mutes.length, "mutes for", itemId);
        if (mutes.length === 0) {
          warnOnce("empty-mutes:" + key, "mute API returned 0 ranges for item " + shortId(itemId));
        } else {
          delete state.warnOnceKeys["empty-mutes:" + key];
        }
        return mutes;
      })
      .catch(function (err) {
        warnOnce("fetch-fail:" + key, "mute fetch failed for item " + shortId(itemId), err);
        state.muteKey = null;
        return state.mutes || [];
      })
      .finally(function () {
        delete state.fetchPending[key];
      });

    state.fetchPending[key] = p;
    return p;
  }

  function loadProfiles() {
    if (state.profilesLoaded) return Promise.resolve(state.profiles);
    return fetchJson("MediaWordFilter/profiles")
      .then(function (data) {
        var list = (data && data.profiles) || [];
        state.profiles = Array.isArray(list) ? list : [];
        state.profilesLoaded = true;
        syncUiControls();
        return state.profiles;
      })
      .catch(function (err) {
        log("profiles failed", err);
        state.profiles = [];
        state.profilesLoaded = true;
        return state.profiles;
      });
  }

  function shortId(id) {
    var n = normalizeItemId(id) || String(id);
    return n.slice(0, 8);
  }

  function fillProfileSelect(sel) {
    if (!sel) return;
    var curUser = currentUserId() || "";
    sel.innerHTML = "";

    var optDefault = document.createElement("option");
    optDefault.value = "";
    optDefault.textContent = curUser
      ? "Current user (" + shortId(curUser) + ")"
      : "Current user";
    sel.appendChild(optDefault);

    for (var i = 0; i < state.profiles.length; i++) {
      var p = state.profiles[i];
      var id = p.jellyfin_user_id || p.jellyfinUserId || p.id || "";
      if (!id) continue;
      var opt = document.createElement("option");
      opt.value = id;
      opt.textContent = p.display_name || p.displayName || shortId(id);
      sel.appendChild(opt);
    }

    if (state.profileUserId) {
      sel.value = state.profileUserId;
      if (sel.value !== state.profileUserId) {
        var syn = document.createElement("option");
        syn.value = state.profileUserId;
        syn.textContent = "Profile " + shortId(state.profileUserId);
        sel.appendChild(syn);
        sel.value = state.profileUserId;
      }
    } else {
      sel.value = "";
    }
  }

  function syncUiControls() {
    try {
      document.querySelectorAll("select.mwf-profile-select").forEach(fillProfileSelect);
      document.querySelectorAll("input.mwf-filter-toggle").forEach(function (el) {
        el.checked = !!state.enabled;
      });
    } catch (_) {}
  }

  function isDetailsHash() {
    return /#\/details/i.test(location.hash || "");
  }

  function findAudioAnchor() {
    var selectors = [
      ".selectAudio",
      "select.selectAudio",
      '[data-action="Audio"]',
      ".audioStreamPicker"
    ];
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function mountDetailsPanel() {
    try {
      if (!FLAGS.enableDetailsUi || !isDetailsHash()) {
        var old = document.getElementById("mwf-details-panel");
        if (old) old.remove();
        state.detailsMountedFor = null;
        return;
      }

      var itemId = extractFromString(location.hash) || extractFromString(location.href);
      var anchor = findAudioAnchor();
      if (!anchor) return;

      var existing = document.getElementById("mwf-details-panel");
      if (existing && state.detailsMountedFor === itemId) return;

      if (existing) existing.remove();

      var panel = document.createElement("div");
      panel.id = "mwf-details-panel";
      panel.className = "mwf-details-panel";
      panel.innerHTML =
        '<p class="mwf-label">Media Word Filter</p>' +
        '<div class="mwf-row">' +
        '<label class="mwf-toggle"><span>Profile</span></label>' +
        '<select class="mwf-profile-select" aria-label="MWF profile"></select>' +
        "</div>" +
        '<div class="mwf-row">' +
        '<label class="mwf-toggle"><input type="checkbox" class="mwf-filter-toggle" /> Use filter</label>' +
        "</div>";

      var mountParent =
        anchor.closest(".selectContainer, .inputContainer, .mediaInfoItem") || anchor.parentElement;
      if (mountParent && mountParent.parentElement) {
        mountParent.insertAdjacentElement("afterend", panel);
      } else {
        anchor.insertAdjacentElement("afterend", panel);
      }

      var sel = panel.querySelector("select.mwf-profile-select");
      var chk = panel.querySelector("input.mwf-filter-toggle");
      sel.addEventListener("change", function () {
        writeProfile(sel.value || "");
      });
      chk.addEventListener("change", function () {
        writeEnabled(chk.checked);
      });

      state.detailsMountedFor = itemId;
      loadProfiles().then(function () {
        fillProfileSelect(sel);
        chk.checked = !!state.enabled;
      });

      if (itemId) {
        if (itemId !== state.itemId) {
          state.itemId = itemId;
          state.itemIdSource = "details";
        }
        ensureMutes(itemId, false);
      }
    } catch (err) {
      log("mountDetailsPanel error", err);
    }
  }

  function prefetchNextEpisode(itemId) {
    if (!FLAGS.enablePrefetch || !state.enabled) return;
    var c = apiClient();
    var userId = currentUserId();
    if (!c || !userId || !itemId || typeof c.getItem !== "function") return;

    c.getItem(userId, itemId)
      .then(function (item) {
        if (!item || item.Type !== "Episode") return null;
        var seasonId = item.SeasonId;
        var index = Number(item.IndexNumber);
        if (!seasonId || !Number.isFinite(index) || typeof c.getItems !== "function") return null;

        return c
          .getItems(userId, {
            ParentId: seasonId,
            IncludeItemTypes: "Episode",
            Recursive: true,
            Fields: "IndexNumber",
            SortBy: "IndexNumber",
            SortOrder: "Ascending"
          })
          .then(function (result) {
            var items = (result && result.Items) || [];
            for (var i = 0; i < items.length; i++) {
              if (Number(items[i].IndexNumber) === index + 1 && items[i].Id) {
                return normalizeItemId(items[i].Id);
              }
            }
            return null;
          });
      })
      .then(function (nextId) {
        if (nextId && nextId !== itemId) {
          log("prefetch next episode", nextId);
          ensureMutes(nextId, false);
        }
      })
      .catch(function (err) {
        log("prefetch failed", err);
      });
  }

  function applyMute(video, shouldMute) {
    if (!video) {
      if (!shouldMute) state.weMuted = false;
      return;
    }
    if (shouldMute) {
      if (!state.weMuted) {
        state.userWasMuted = !!video.muted;
        state.weMuted = true;
      }
      if (!video.muted) video.muted = true;
    } else if (state.weMuted) {
      video.muted = !!state.userWasMuted;
      state.weMuted = false;
    }
  }

  function tickDiagnostics(video) {
    if (!state.enabled) return;
    var diag = !video
      ? "no-video"
      : !state.itemId
        ? "no-item-id"
        : !state.mutes || !state.mutes.length
          ? "no-mutes"
          : "ready";
    if (diag === state.lastTickDiag) return;
    state.lastTickDiag = diag;
    if (diag === "no-video" && /#\/video/i.test(location.hash || "")) {
      warnOnce("no-video", "video element not found on #/video route");
    } else if (diag === "no-item-id" && video) {
      warnOnce("no-item-id", "could not resolve Jellyfin item id during playback");
    } else if (diag === "no-mutes" && video && state.itemId) {
      warnOnce("no-mutes:" + cacheKey(state.itemId), "no mute ranges loaded for item " + shortId(state.itemId));
    } else if (diag === "ready") {
      log("mute loop ready", state.mutes.length, "ranges for", shortId(state.itemId));
    }
  }

  function tick(forceRefresh) {
    try {
      var video = findVideo();
      refreshPlaybackItem(video, !!forceRefresh);

      if (!state.enabled) {
        if (state.weMuted) applyMute(video, false);
        tickDiagnostics(video);
        return;
      }

      if (video && state.itemId && (!state.mutes || !state.mutes.length) && !state.fetchPending[cacheKey(state.itemId)]) {
        ensureMutes(state.itemId, false);
      }

      if (!video || !state.mutes || !state.mutes.length) {
        if (state.weMuted) applyMute(video, false);
        tickDiagnostics(video);
        return;
      }

      applyMute(video, inMuteRange(playbackMs(video), state.mutes));
      tickDiagnostics(video);
    } catch (err) {
      warnOnce("tick-error", "tick error", err);
    }
  }

  function onRouteChange() {
    state.detailsMountedFor = null;
    setTimeout(function () {
      mountDetailsPanel();
      tick();
    }, 100);
  }

  function hookHistory() {
    try {
      window.addEventListener("popstate", onRouteChange);
      window.addEventListener("hashchange", onRouteChange);
      // Do not wrap history.pushState/replaceState — that can break player UI.
    } catch (err) {
      log("hookHistory error", err);
    }
  }

  function hookPlaybackEvents() {
    if (state.playbackHooksAttached) return false;
    try {
      var Events = window.Events;
      var pm = playbackManager();
      if (!Events || !pm || typeof Events.on !== "function") return false;

      Events.on(pm, "playbackstart", function () {
        tick(true);
      });
      Events.on(pm, "playbackstop", function () {
        if (state.weMuted && state.video) applyMute(state.video, false);
        if (!findVideo()) {
          state.video = null;
          state.itemId = null;
          state.itemIdSource = null;
          state.mutes = [];
          state.muteKey = null;
        }
      });
      Events.on(pm, "playerchange", function () {
        tick(true);
      });
      state.playbackHooksAttached = true;
      log("playback events hooked");
      return true;
    } catch (err) {
      log("hookPlaybackEvents error", err);
      return false;
    }
  }

  function ensurePlaybackHooks() {
    if (hookPlaybackEvents()) return;
    var attempts = 0;
    var timer = setInterval(function () {
      attempts++;
      if (hookPlaybackEvents() || attempts >= 60) clearInterval(timer);
    }, 500);
  }

  function observeDom() {
    var detailsTimer = null;
    try {
      var obs = new MutationObserver(function () {
        var video = findVideo();
        if (video !== state.video) {
          tick(true);
        }
        if (!isDetailsHash()) return;
        if (detailsTimer) clearTimeout(detailsTimer);
        detailsTimer = setTimeout(function () {
          detailsTimer = null;
          mountDetailsPanel();
        }, 400);
      });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (_) {}
  }

  function init() {
    try {
      loadProfiles();
      hookHistory();
      ensurePlaybackHooks();
      observeDom();
      mountDetailsPanel();
      setInterval(tick, POLL_MS);
      tick();
      log("client ready v" + CLIENT_VERSION, FLAGS);
    } catch (err) {
      console.warn("[mwf-plugin] init failed", err);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
