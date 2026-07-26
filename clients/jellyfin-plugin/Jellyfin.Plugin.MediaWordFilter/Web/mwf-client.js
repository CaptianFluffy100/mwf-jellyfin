/**
 * Media Word Filter — Jellyfin Web client (server plugin).
 * Audio mute uses Web Audio GainNode (gain 0 / restore) — avoids Chromium mute/volume icons.
 * Filter prefs are per Jellyfin user (saved on the server) and apply to all titles.
 * Details-page prefs control blasphemy / profanity tiers / view skip|block|off.
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
  var LS_PREFS = "mwfFilterPrefs.v2";
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

  var CLIENT_VERSION = "1.0.20.0";
  // Have enough buffered media before mute/skip/overlay touch the element.
  var MIN_READY = 3; // HAVE_FUTURE_DATA
  var SETTLE_MS = 500;
  // Do not touch mute/fetch/WebAudio until the player has been playing this long.
  // Attaching MediaElementSource or fetching mutes during load stalls Jellyfin Web
  // (JMP is fine — it never runs this script).
  var FILTER_ARM_MS = 2500;
  var GRAPH_KEY = "__mwfAudioGraph";
  var PREFS_SAVE_MS = 350;

  var state = {
    enabled: readEnabled(),
    prefs: readPrefs(),
    prefsLoadedFromServer: false,
    prefsSaveTimer: null,
    itemId: null,
    itemIdSource: null,
    mutes: [],
    viewFilter: { block: [], skip: [] },
    muteDoc: null,
    muteKey: null,
    weMuted: false,
    savedGain: 1,
    audioGraph: null,
    video: null,
    cache: Object.create(null),
    fetchPending: Object.create(null),
    detailsMountedFor: null,
    playbackHooksAttached: false,
    warnOnceKeys: Object.create(null),
    lastTickDiag: null,
    lastSkipId: null,
    overlayHost: null,
    viewLabelsKey: "",
    playbackSettled: false,
    settleTimer: null,
    hookedVideo: null,
    filtersArmed: false,
    armTimer: null
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
    cachePrefsLocally();
    syncUiControls();
    rebuildFromCachedDoc();
    ensureMutes(state.itemId, true);
    schedulePrefsSave();
  }

  function defaultPrefs() {
    return {
      blasphemy: true,
      profanity1: true,
      profanity2: true,
      profanity3: true,
      // matched label -> "skip" | "block" | "off"
      viewMatched: {}
    };
  }

  function normalizePrefsObject(parsed) {
    var d = defaultPrefs();
    if (!parsed || typeof parsed !== "object") return d;
    // Accept camelCase (client) and PascalCase (some Jellyfin serializers).
    var blasphemy = parsed.blasphemy;
    if (blasphemy === undefined) blasphemy = parsed.Blasphemy;
    var p1 = parsed.profanity1;
    if (p1 === undefined) p1 = parsed.Profanity1;
    var p2 = parsed.profanity2;
    if (p2 === undefined) p2 = parsed.Profanity2;
    var p3 = parsed.profanity3;
    if (p3 === undefined) p3 = parsed.Profanity3;
    var vm = parsed.viewMatched;
    if (vm === undefined) vm = parsed.ViewMatched;
    d.blasphemy = blasphemy !== false;
    d.profanity1 = p1 !== false;
    d.profanity2 = p2 !== false;
    d.profanity3 = p3 !== false;
    d.viewMatched = vm && typeof vm === "object" ? vm : {};
    return d;
  }

  function readPrefs() {
    try {
      var raw = localStorage.getItem(LS_PREFS);
      if (!raw) return defaultPrefs();
      return normalizePrefsObject(JSON.parse(raw));
    } catch (_) {
      return defaultPrefs();
    }
  }

  function cachePrefsLocally() {
    try {
      localStorage.setItem(LS_ENABLED, state.enabled ? "1" : "0");
      localStorage.setItem(LS_PREFS, JSON.stringify(state.prefs));
    } catch (_) {}
  }

  function prefsPayload() {
    return {
      enabled: !!state.enabled,
      blasphemy: state.prefs.blasphemy !== false,
      profanity1: state.prefs.profanity1 !== false,
      profanity2: state.prefs.profanity2 !== false,
      profanity3: state.prefs.profanity3 !== false,
      viewMatched: state.prefs.viewMatched || {}
    };
  }

  function applyPrefsState(doc, enabledOverride) {
    state.prefs = normalizePrefsObject(doc);
    if (enabledOverride !== undefined) {
      state.enabled = !!enabledOverride;
    } else if (doc && Object.prototype.hasOwnProperty.call(doc, "enabled")) {
      state.enabled = doc.enabled !== false;
    } else if (doc && Object.prototype.hasOwnProperty.call(doc, "Enabled")) {
      state.enabled = doc.Enabled !== false;
    }
    cachePrefsLocally();
    syncUiControls();
    rebuildFromCachedDoc();
    refreshDetailsViewLabels(false);
  }

  function prefsIsStored(doc) {
    if (!doc) return false;
    return doc.stored === true || doc.Stored === true;
  }

  function writePrefs(partial) {
    var next = Object.assign({}, state.prefs, partial || {});
    if (partial && Object.prototype.hasOwnProperty.call(partial, "viewMatched")) {
      next.viewMatched = partial.viewMatched || {};
    }
    state.prefs = next;
    cachePrefsLocally();
    syncUiControls();
    rebuildFromCachedDoc();
    // Do not rebuild view <select>s on every pref write — that breaks open dropdowns.
    if (partial && Object.prototype.hasOwnProperty.call(partial, "viewMatched")) {
      syncViewSelectValues();
    }
    schedulePrefsSave();
  }

  function schedulePrefsSave() {
    if (state.prefsSaveTimer) clearTimeout(state.prefsSaveTimer);
    state.prefsSaveTimer = setTimeout(function () {
      state.prefsSaveTimer = null;
      savePrefsToServer();
    }, PREFS_SAVE_MS);
  }

  function putJson(path, body) {
    var c = apiClient();
    // Prefer ApiClient.ajax — it attaches a valid Jellyfin token (avoids Invalid token).
    if (c && typeof c.ajax === "function" && typeof c.getUrl === "function") {
      return Promise.resolve(
        c.ajax({
          type: "PUT",
          url: c.getUrl(path.replace(/^\//, "")),
          data: JSON.stringify(body),
          contentType: "application/json",
          dataType: "json"
        })
      );
    }
    return fetch(apiUrl(path), {
      method: "PUT",
      credentials: "same-origin",
      headers: Object.assign(
        { "Content-Type": "application/json", Accept: "application/json" },
        authHeaders()
      ),
      body: JSON.stringify(body)
    }).then(function (res) {
      if (res.status === 401) {
        console.warn("[mwf-plugin] prefs save returned 401");
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

  function getJson(path) {
    var c = apiClient();
    if (c && typeof c.getJSON === "function" && typeof c.getUrl === "function") {
      return Promise.resolve(c.getJSON(c.getUrl(path.replace(/^\//, ""))));
    }
    return fetchJson(path);
  }

  function savePrefsToServer() {
    if (!hasAuthToken()) return Promise.resolve();
    return putJson("MediaWordFilter/prefs", prefsPayload())
      .then(function () {
        state.prefsLoadedFromServer = true;
        delete state.warnOnceKeys["prefs-save-fail"];
        delete state.warnOnceKeys["prefs-401"];
        log("prefs saved to Jellyfin user");
      })
      .catch(function (err) {
        console.warn("[mwf-plugin] could not save filter prefs to Jellyfin", err);
      });
  }

  function loadPrefsFromServer() {
    if (!hasAuthToken()) {
      return Promise.resolve(false);
    }
    return getJson("MediaWordFilter/prefs")
      .then(function (doc) {
        if (!doc) return false;
        if (!prefsIsStored(doc)) {
          // First time on server: push local browser prefs (migrate), then done.
          return savePrefsToServer().then(function () {
            state.prefsLoadedFromServer = true;
            return true;
          });
        }
        applyPrefsState(doc);
        state.prefsLoadedFromServer = true;
        delete state.warnOnceKeys["prefs-load-fail"];
        log("prefs loaded from Jellyfin user");
        return true;
      })
      .catch(function (err) {
        console.warn("[mwf-plugin] could not load filter prefs from Jellyfin; using local cache", err);
        return false;
      });
  }

  function setViewMatchedAction(matched, action) {
    var map = Object.assign({}, state.prefs.viewMatched || {});
    if (!action || action === "off") delete map[matched];
    else map[matched] = action;
    writePrefs({ viewMatched: map });
  }

  function viewActionFor(matched) {
    var a = (state.prefs.viewMatched || {})[matched];
    if (a === "skip" || a === "block") return a;
    return "off";
  }

  function syncViewSelectValues() {
    try {
      document.querySelectorAll("select.mwf-view-action").forEach(function (sel) {
        var matched = sel.getAttribute("data-matched");
        var want = viewActionFor(matched);
        if (sel.value !== want) sel.value = want;
      });
    } catch (_) {}
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

  function parseMuteDocument(data, prefs) {
    prefs = prefs || state.prefs || defaultPrefs();

    function pushRanges(list, out) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var start_ms = Number(list[i].start_ms);
        var end_ms = Number(list[i].end_ms);
        if (Number.isFinite(start_ms) && Number.isFinite(end_ms)) {
          out.push({ start_ms: start_ms, end_ms: end_ms });
        }
      }
    }

    var mutes = [];
    var raw = data && data.mutes;

    // Legacy mute.v1: flat array
    if (Array.isArray(raw)) {
      pushRanges(raw, mutes);
      return mutes;
    }

    // mute.v2 buckets — each category/tier is independently selectable
    if (raw && typeof raw === "object") {
      if (prefs.blasphemy !== false) pushRanges(raw.blasphemy, mutes);
      if (raw.profanity && typeof raw.profanity === "object") {
        if (prefs.profanity1 !== false) {
          pushRanges(raw.profanity["1"] || raw.profanity.tier1, mutes);
        }
        if (prefs.profanity2 !== false) {
          pushRanges(raw.profanity["2"] || raw.profanity.tier2, mutes);
        }
        if (prefs.profanity3 !== false) {
          pushRanges(raw.profanity["3"] || raw.profanity.tier3, mutes);
        }
      }
    }
    return mutes;
  }

  function parseViewFilter(data) {
    var vf = (data && data.view_filter) || {};
    return {
      block: Array.isArray(vf.block) ? vf.block : [],
      skip: Array.isArray(vf.skip) ? vf.skip : []
    };
  }

  function collectMatchedLabels(viewFilter) {
    var set = {};
    var lists = [viewFilter.block || [], viewFilter.skip || []];
    for (var i = 0; i < lists.length; i++) {
      for (var j = 0; j < lists[i].length; j++) {
        var m = (lists[i][j].matched || "").trim();
        if (m) set[m] = true;
      }
    }
    return Object.keys(set).sort();
  }

  function rebuildFromCachedDoc() {
    if (!state.muteDoc) {
      state.mutes = [];
      state.viewFilter = { block: [], skip: [] };
      hideBlockOverlay();
      return;
    }
    if (!state.enabled) {
      state.mutes = [];
      state.viewFilter = { block: [], skip: [] };
      hideBlockOverlay();
      if (state.weMuted) applyMute(state.video, false);
      return;
    }
    state.mutes = parseMuteDocument(state.muteDoc, state.prefs);
    state.viewFilter = parseViewFilter(state.muteDoc);
  }

  function applyDocToState(doc, itemId) {
    state.muteDoc = doc || null;
    rebuildFromCachedDoc();
    log(
      "loaded",
      state.mutes.length,
      "audio mutes,",
      (state.viewFilter.block || []).length,
      "blocks,",
      (state.viewFilter.skip || []).length,
      "skips for",
      itemId
    );
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
    // Only fall back to stored credentials when ApiClient has no live token.
    if (!tok) tok = accessTokenFromCredentials();
    if (tok) {
      // X-Emby-Token alone is enough. A hand-built Authorization header can
      // make Jellyfin respond with "Invalid token."
      headers["X-Emby-Token"] = tok;
    }
    return headers;
  }

  function hasAuthToken() {
    var c = apiClient();
    try {
      if (c && typeof c.accessToken === "function" && c.accessToken()) return true;
    } catch (_) {}
    try {
      if (c && typeof c.getAccessToken === "function" && c.getAccessToken()) return true;
    } catch (_) {}
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
    // Profiles removed — shared mute doc per item only.
    return "";
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
      state.lastSkipId = null;
      markPlaybackUnsettled();
      hideBlockOverlay();
      // Never fetch mutes during browser player startup — that races the stream.
      if (newId && state.filtersArmed) {
        log("item id", newId, "via", newSource);
        ensureMutes(newId, false).then(function () {
          prefetchNextEpisode(newId);
        });
      } else if (!newId) {
        state.mutes = [];
        state.muteDoc = null;
      } else {
        log("item id", newId, "via", newSource, "(fetch deferred until filters armed)");
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
    return itemId || "";
  }

  function ensureMutes(itemId, force) {
    if (!itemId) {
      state.mutes = [];
      state.viewFilter = { block: [], skip: [] };
      state.muteDoc = null;
      state.muteKey = null;
      hideBlockOverlay();
      return Promise.resolve([]);
    }
    if (!state.enabled) {
      state.mutes = [];
      state.viewFilter = { block: [], skip: [] };
      state.muteKey = cacheKey(itemId) + "|off";
      hideBlockOverlay();
      return Promise.resolve([]);
    }

    var key = cacheKey(itemId);
    if (!force && state.muteKey === key && state.cache[key]) {
      applyDocToState(state.cache[key].doc, itemId);
      return Promise.resolve(state.mutes);
    }
    if (state.cache[key] && !force) {
      applyDocToState(state.cache[key].doc, itemId);
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

    // Shared item mute doc only — no user_id / profile rematch.
    var path = "MediaWordFilter/mutes/" + encodeURIComponent(itemId);

    var p = fetchJson(path)
      .then(function (doc) {
        state.cache[key] = { doc: doc, fetchedAt: Date.now() };
        applyDocToState(doc, itemId);
        state.muteKey = key;
        delete state.warnOnceKeys["auth-401:" + path];
        if (state.mutes.length === 0 && !(state.viewFilter.block || []).length && !(state.viewFilter.skip || []).length) {
          warnOnce("empty-mutes:" + key, "mute API returned 0 ranges for item " + shortId(itemId));
        } else {
          delete state.warnOnceKeys["empty-mutes:" + key];
        }
        refreshDetailsViewLabels(true);
        return state.mutes;
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

  function shortId(id) {
    var n = normalizeItemId(id) || String(id);
    return n.slice(0, 8);
  }

  function syncUiControls() {
    try {
      document.querySelectorAll("input.mwf-filter-toggle").forEach(function (el) {
        el.checked = !!state.enabled;
      });
      var p = state.prefs || defaultPrefs();
      document.querySelectorAll("input.mwf-pref-blasphemy").forEach(function (el) {
        el.checked = p.blasphemy !== false;
      });
      document.querySelectorAll("input.mwf-pref-p1").forEach(function (el) {
        el.checked = p.profanity1 !== false;
      });
      document.querySelectorAll("input.mwf-pref-p2").forEach(function (el) {
        el.checked = p.profanity2 !== false;
      });
      document.querySelectorAll("input.mwf-pref-p3").forEach(function (el) {
        el.checked = p.profanity3 !== false;
      });
      syncViewSelectValues();
    } catch (_) {}
  }

  function refreshDetailsViewLabels(force) {
    var host = document.querySelector("#mwf-details-panel .mwf-view-list");
    if (!host) return;
    var labels = collectMatchedLabels(state.viewFilter || { block: [], skip: [] });
    if (!labels.length && state.muteDoc) {
      labels = collectMatchedLabels(parseViewFilter(state.muteDoc));
    }
    var key = labels.join("\0");
    if (!force && key === state.viewLabelsKey && host.querySelector("select.mwf-view-action")) {
      syncViewSelectValues();
      return;
    }
    state.viewLabelsKey = key;
    if (!labels.length) {
      host.innerHTML =
        '<p class="mwf-hint">No skip/block scenes for this item yet.</p>';
      return;
    }
    host.innerHTML = labels
      .map(function (label) {
        var cur = viewActionFor(label);
        return (
          '<div class="mwf-row mwf-view-row">' +
          '<span class="mwf-matched">' +
          escapeHtml(label) +
          "</span>" +
          '<select class="mwf-view-action" data-matched="' +
          escapeAttr(label) +
          '" aria-label="Action for ' +
          escapeAttr(label) +
          '">' +
          '<option value="off"' +
          (cur === "off" ? " selected" : "") +
          ">Off</option>" +
          '<option value="block"' +
          (cur === "block" ? " selected" : "") +
          ">Block</option>" +
          '<option value="skip"' +
          (cur === "skip" ? " selected" : "") +
          ">Skip</option>" +
          "</select></div>"
        );
      })
      .join("");
    host.querySelectorAll("select.mwf-view-action").forEach(function (sel) {
      sel.addEventListener("change", function () {
        setViewMatchedAction(sel.getAttribute("data-matched"), sel.value);
      });
    });
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
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
      if (existing && state.detailsMountedFor === itemId) {
        refreshDetailsViewLabels(false);
        return;
      }

      if (existing) existing.remove();

      var panel = document.createElement("div");
      panel.id = "mwf-details-panel";
      panel.className = "mwf-details-panel";
      panel.innerHTML =
        '<p class="mwf-label">Media Word Filter</p>' +
        '<div class="mwf-row">' +
        '<label class="mwf-toggle"><input type="checkbox" class="mwf-filter-toggle" /> Use filter</label>' +
        "</div>" +
        '<p class="mwf-sublabel">Audio mutes</p>' +
        '<div class="mwf-row mwf-checks">' +
        '<label class="mwf-toggle"><input type="checkbox" class="mwf-pref-blasphemy" /> Blasphemy</label>' +
        '<label class="mwf-toggle"><input type="checkbox" class="mwf-pref-p1" /> Profanity T1</label>' +
        '<label class="mwf-toggle"><input type="checkbox" class="mwf-pref-p2" /> Profanity T2</label>' +
        '<label class="mwf-toggle"><input type="checkbox" class="mwf-pref-p3" /> Profanity T3</label>' +
        "</div>" +
        '<p class="mwf-sublabel">Scenes (skip / block)</p>' +
        '<div class="mwf-view-list"></div>' +
        '<p class="mwf-hint">These choices apply to <strong>all</strong> movies &amp; shows for your Jellyfin account (synced across devices). Skip jumps the span; Block covers with boxes. If Skip is chosen but only a block exists, block is used.</p>';

      var mountParent =
        anchor.closest(".selectContainer, .inputContainer, .mediaInfoItem") || anchor.parentElement;
      if (mountParent && mountParent.parentElement) {
        mountParent.insertAdjacentElement("afterend", panel);
      } else {
        anchor.insertAdjacentElement("afterend", panel);
      }

      var chk = panel.querySelector("input.mwf-filter-toggle");
      chk.addEventListener("change", function () {
        writeEnabled(chk.checked);
      });
      panel.querySelector(".mwf-pref-blasphemy").addEventListener("change", function (e) {
        writePrefs({ blasphemy: e.target.checked });
      });
      panel.querySelector(".mwf-pref-p1").addEventListener("change", function (e) {
        writePrefs({ profanity1: e.target.checked });
      });
      panel.querySelector(".mwf-pref-p2").addEventListener("change", function (e) {
        writePrefs({ profanity2: e.target.checked });
      });
      panel.querySelector(".mwf-pref-p3").addEventListener("change", function (e) {
        writePrefs({ profanity3: e.target.checked });
      });

      state.detailsMountedFor = itemId;
      state.viewLabelsKey = "";
      syncUiControls();

      if (itemId) {
        if (itemId !== state.itemId) {
          state.itemId = itemId;
          state.itemIdSource = "details";
        }
        ensureMutes(itemId, false).then(function () {
          refreshDetailsViewLabels(true);
        });
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

  function resumeAudioContext(ctx) {
    if (!ctx) return;
    try {
      if (ctx.state === "suspended") {
        var p = ctx.resume();
        if (p && typeof p.catch === "function") p.catch(function () {});
      }
    } catch (_) {}
  }

  function ensureAudioGraph(video) {
    if (!video) return null;
    if (video[GRAPH_KEY] && video[GRAPH_KEY].gain) {
      state.audioGraph = video[GRAPH_KEY];
      resumeAudioContext(state.audioGraph.ctx);
      return state.audioGraph;
    }

    // Hard gate: never create MediaElementSource until filters are armed.
    // createMediaElementSource permanently takes over element audio and will
    // stall Jellyfin Web if done during load.
    if (!state.filtersArmed || !state.playbackSettled) {
      return null;
    }
    if (video.readyState < MIN_READY || video.paused) {
      return null;
    }

    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) {
      warnOnce("no-audio-ctx", "Web Audio API unavailable; cannot gain-mute");
      return null;
    }

    try {
      var ctx = new AC();
      var source = ctx.createMediaElementSource(video);
      var gain = ctx.createGain();
      gain.gain.value = 1;
      source.connect(gain);
      gain.connect(ctx.destination);
      var graph = { video: video, ctx: ctx, source: source, gain: gain };
      video[GRAPH_KEY] = graph;
      state.audioGraph = graph;
      resumeAudioContext(ctx);
      log("audio gain graph attached (lazy, after arm)");
      return graph;
    } catch (err) {
      warnOnce(
        "audio-graph-fail",
        "could not attach Web Audio gain graph (element may already have a source node)",
        err
      );
      return null;
    }
  }

  function setGainValue(graph, value) {
    if (!graph || !graph.gain) return;
    var gainParam = graph.gain.gain;
    var v = Number(value);
    if (!Number.isFinite(v)) v = 1;
    try {
      var t = graph.ctx && typeof graph.ctx.currentTime === "number" ? graph.ctx.currentTime : 0;
      if (typeof gainParam.cancelScheduledValues === "function") {
        gainParam.cancelScheduledValues(t);
        gainParam.setValueAtTime(v, t);
      } else {
        gainParam.value = v;
      }
    } catch (_) {
      try {
        gainParam.value = v;
      } catch (__) {}
    }
  }

  function applyMute(video, shouldMute) {
    if (!video) {
      if (!shouldMute) state.weMuted = false;
      return;
    }

    if (!state.filtersArmed) {
      return;
    }

    // Lazy graph: only create when we actually need to mute.
    if (shouldMute) {
      if (!state.playbackSettled || video.readyState < MIN_READY) return;
      var graph = ensureAudioGraph(video);
      if (!graph || !graph.gain) return;

      resumeAudioContext(graph.ctx);

      if (!state.weMuted) {
        var cur = Number(graph.gain.gain.value);
        state.savedGain = Number.isFinite(cur) && cur > 0 ? cur : 1;
        state.weMuted = true;
      }
      setGainValue(graph, 0);
    } else if (state.weMuted) {
      var existing = state.audioGraph || video[GRAPH_KEY] || null;
      if (existing && existing.gain) {
        var restore = Number(state.savedGain);
        if (!Number.isFinite(restore) || restore <= 0) restore = 1;
        setGainValue(existing, restore);
      }
      state.weMuted = false;
    }
  }

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function smoothstep(t) {
    var x = Math.min(1, Math.max(0, t));
    return x * x * (3 - 2 * x);
  }

  function sampleTrack(keyframes, relMs) {
    if (!keyframes || !keyframes.length) return null;
    var sorted = keyframes.slice().sort(function (a, b) {
      return a.time_ms - b.time_ms;
    });
    if (relMs <= sorted[0].time_ms) {
      return {
        id: sorted[0].id,
        rec_center: sorted[0].rec_center,
        rec_size: sorted[0].rec_size
      };
    }
    var last = sorted[sorted.length - 1];
    if (relMs >= last.time_ms) {
      return { id: last.id, rec_center: last.rec_center, rec_size: last.rec_size };
    }
    for (var i = 0; i < sorted.length - 1; i++) {
      var a = sorted[i];
      var b = sorted[i + 1];
      if (relMs >= a.time_ms && relMs <= b.time_ms) {
        var t = smoothstep((relMs - a.time_ms) / Math.max(1, b.time_ms - a.time_ms));
        return {
          id: a.id,
          rec_center: {
            x: lerp(a.rec_center.x, b.rec_center.x, t),
            y: lerp(a.rec_center.y, b.rec_center.y, t)
          },
          rec_size: {
            w: lerp(a.rec_size.w, b.rec_size.w, t),
            h: lerp(a.rec_size.h, b.rec_size.h, t)
          }
        };
      }
    }
    return null;
  }

  function activeScenesAt(tMs) {
    var vf = state.viewFilter || { block: [], skip: [] };
    var skips = [];
    var blocks = [];
    var i;
    for (i = 0; i < (vf.skip || []).length; i++) {
      var s = vf.skip[i];
      if (tMs >= s.start_ms && tMs < s.end_ms) skips.push(s);
    }
    for (i = 0; i < (vf.block || []).length; i++) {
      var b = vf.block[i];
      if (tMs >= b.start_ms && tMs < b.end_ms) blocks.push(b);
    }
    return { skips: skips, blocks: blocks };
  }

  /**
   * Resolve skip/block from prefs.
   * skip preferred when chosen; if no skip exists for that matched, fall back to block.
   */
  function resolveViewActions(tMs) {
    var active = activeScenesAt(tMs);
    var skipScene = null;
    var blockScenes = [];
    var seenBlock = {};

    function want(matched) {
      return viewActionFor(matched || "");
    }

    var i;
    for (i = 0; i < active.skips.length; i++) {
      if (want(active.skips[i].matched) === "skip") {
        skipScene = active.skips[i];
        break;
      }
    }

    for (i = 0; i < active.blocks.length; i++) {
      var sc = active.blocks[i];
      var action = want(sc.matched);
      if (action === "block") {
        blockScenes.push(sc);
        seenBlock[sc.id] = true;
      } else if (action === "skip") {
        // User asked to skip this matched label; only block if no skip scene covers it.
        var hasSkip = false;
        for (var j = 0; j < active.skips.length; j++) {
          if (
            active.skips[j].matched === sc.matched &&
            tMs >= active.skips[j].start_ms &&
            tMs < active.skips[j].end_ms
          ) {
            hasSkip = true;
            break;
          }
        }
        if (!hasSkip && !seenBlock[sc.id]) {
          blockScenes.push(sc);
          seenBlock[sc.id] = true;
        }
      }
    }

    // If skip was requested for a matched that only has skip (no block), skipScene already set.
    // If skip requested for matched that only has block, blockScenes got it above.
    // Also: skip action with skip scene present — don't also show blocks for same matched.
    if (skipScene) {
      blockScenes = blockScenes.filter(function (sc) {
        return sc.matched !== skipScene.matched;
      });
    }

    return { skip: skipScene, blocks: blockScenes };
  }

  function markPlaybackUnsettled() {
    state.playbackSettled = false;
    if (state.settleTimer) {
      clearTimeout(state.settleTimer);
      state.settleTimer = null;
    }
  }

  function disarmFilters(reason) {
    state.filtersArmed = false;
    if (state.armTimer) {
      clearTimeout(state.armTimer);
      state.armTimer = null;
    }
    markPlaybackUnsettled();
    if (reason) log("filters disarmed:", reason);
  }

  function scheduleFilterArm() {
    if (state.armTimer) clearTimeout(state.armTimer);
    state.armTimer = setTimeout(function () {
      state.armTimer = null;
      var video = state.video || findVideo();
      if (
        video &&
        !video.paused &&
        !video.seeking &&
        !video.ended &&
        video.readyState >= MIN_READY
      ) {
        state.filtersArmed = true;
        state.playbackSettled = true;
        log("filters armed after", FILTER_ARM_MS, "ms stable play");
        if (state.enabled && state.itemId) {
          ensureMutes(state.itemId, false).then(function () {
            prefetchNextEpisode(state.itemId);
          });
        }
      } else {
        // Still buffering — try again once playback looks healthy.
        scheduleFilterArm();
      }
    }, FILTER_ARM_MS);
  }

  function schedulePlaybackSettle() {
    if (state.settleTimer) clearTimeout(state.settleTimer);
    state.settleTimer = setTimeout(function () {
      state.settleTimer = null;
      var video = state.video || findVideo();
      if (
        video &&
        !video.paused &&
        !video.seeking &&
        video.readyState >= MIN_READY
      ) {
        state.playbackSettled = true;
      }
    }, SETTLE_MS);
  }

  function mediaIsPlayable(video) {
    return !!(
      video &&
      video.readyState >= MIN_READY &&
      !video.seeking &&
      !video.ended
    );
  }

  function isVideoHash() {
    return /#\/video/i.test(location.hash || "");
  }

  function hookVideoLifecycle(video) {
    if (!video || video === state.hookedVideo) return;
    unhookVideoLifecycle();
    state.hookedVideo = video;
    var onBusy = function () {
      // During initial load, buffering is normal — only disarm if we had armed.
      if (state.filtersArmed) {
        markPlaybackUnsettled();
        hideBlockOverlay();
      }
    };
    var onPlaying = function () {
      schedulePlaybackSettle();
      if (!state.filtersArmed) scheduleFilterArm();
    };
    video.addEventListener("waiting", onBusy);
    video.addEventListener("seeking", onBusy);
    video.addEventListener("stalled", onBusy);
    video.addEventListener("playing", onPlaying);
    state._videoLifecycle = { onBusy: onBusy, onPlaying: onPlaying };
  }

  function unhookVideoLifecycle() {
    var video = state.hookedVideo;
    var handlers = state._videoLifecycle;
    if (video && handlers) {
      try {
        video.removeEventListener("waiting", handlers.onBusy);
        video.removeEventListener("seeking", handlers.onBusy);
        video.removeEventListener("stalled", handlers.onBusy);
        video.removeEventListener("playing", handlers.onPlaying);
      } catch (_) {}
    }
    state.hookedVideo = null;
    state._videoLifecycle = null;
    markPlaybackUnsettled();
  }

  function farthestSkipEnd(tMs, seed) {
    if (!seed) return null;
    var endMs = Number(seed.end_ms);
    if (!Number.isFinite(endMs)) return seed;
    var guard = 0;
    var changed = true;
    while (changed && guard++ < 32) {
      changed = false;
      var active = activeScenesAt(Math.max(tMs, endMs - 1));
      for (var i = 0; i < active.skips.length; i++) {
        var s = active.skips[i];
        if (viewActionFor(s.matched || "") !== "skip") continue;
        var sEnd = Number(s.end_ms);
        if (!Number.isFinite(sEnd)) continue;
        // Contiguous / overlapping skip windows — jump once past the chain.
        if (s.start_ms <= endMs + 50 && sEnd > endMs) {
          endMs = sEnd;
          seed = s;
          changed = true;
        }
      }
    }
    return { id: seed.id, matched: seed.matched, end_ms: endMs };
  }

  function ensureOverlayHost(video) {
    if (!video) {
      hideBlockOverlay();
      return null;
    }
    // Never mutate Jellyfin video parent styles — that breaks playback UI.
    var host = state.overlayHost;
    if (!host || !host.isConnected) {
      host = document.createElement("div");
      host.className = "mwf-block-overlay";
      host.setAttribute("aria-hidden", "true");
      host.style.display = "none";
      document.body.appendChild(host);
      state.overlayHost = host;
    }
    var rect = video.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      hideBlockOverlay();
      return null;
    }
    host.style.left = rect.left + "px";
    host.style.top = rect.top + "px";
    host.style.width = rect.width + "px";
    host.style.height = rect.height + "px";
    host.style.display = "block";
    return host;
  }

  function hideBlockOverlay() {
    if (state.overlayHost) {
      state.overlayHost.style.display = "none";
      state.overlayHost.innerHTML = "";
    }
  }

  function clearBlockOverlay() {
    if (state.overlayHost) {
      try {
        state.overlayHost.remove();
      } catch (_) {}
      state.overlayHost = null;
    }
  }

  function renderBlockOverlay(video, blockScenes, tMs) {
    if (!blockScenes || !blockScenes.length) {
      hideBlockOverlay();
      return;
    }
    if (!mediaIsPlayable(video) || !state.playbackSettled) {
      return;
    }
    var host = ensureOverlayHost(video);
    if (!host) return;

    var samples = [];
    for (var i = 0; i < blockScenes.length; i++) {
      var scene = blockScenes[i];
      var rel = tMs - scene.start_ms;
      var byId = {};
      var kfs = scene.blocks || [];
      for (var k = 0; k < kfs.length; k++) {
        var id = kfs[k].id || "legacy";
        if (!byId[id]) byId[id] = [];
        byId[id].push(kfs[k]);
      }
      Object.keys(byId).forEach(function (id) {
        var sample = sampleTrack(byId[id], rel);
        if (sample) samples.push(sample);
      });
    }

    var existing = {};
    host.querySelectorAll(".mwf-block-rect").forEach(function (el) {
      existing[el.dataset.blockId] = el;
    });
    var keep = {};
    for (var s = 0; s < samples.length; s++) {
      var sample = samples[s];
      keep[sample.id] = true;
      var el = existing[sample.id];
      if (!el) {
        el = document.createElement("div");
        el.className = "mwf-block-rect";
        el.dataset.blockId = sample.id;
        host.appendChild(el);
      }
      el.style.left = sample.rec_center.x - sample.rec_size.w / 2 + "%";
      el.style.top = sample.rec_center.y - sample.rec_size.h / 2 + "%";
      el.style.width = sample.rec_size.w + "%";
      el.style.height = sample.rec_size.h + "%";
    }
    Object.keys(existing).forEach(function (id) {
      if (!keep[id]) existing[id].remove();
    });
  }

  function applyViewFilter(video, tMs) {
    if (!video || !state.enabled || !state.filtersArmed) {
      hideBlockOverlay();
      state.lastSkipId = null;
      return;
    }
    // Never seek/overlay while the player is still buffering or settling.
    if (!state.playbackSettled || !mediaIsPlayable(video) || video.paused) {
      hideBlockOverlay();
      return;
    }
    var resolved = resolveViewActions(tMs);
    if (resolved.skip) {
      var jump = farthestSkipEnd(tMs, resolved.skip);
      if (
        jump &&
        state.lastSkipId !== jump.id + ":" + jump.end_ms &&
        !video.seeking
      ) {
        state.lastSkipId = jump.id + ":" + jump.end_ms;
        var endSec = Number(jump.end_ms) / 1000;
        if (Number.isFinite(endSec) && endSec > video.currentTime + 0.15) {
          markPlaybackUnsettled();
          log("skip to", endSec, jump.matched);
          try {
            video.currentTime = endSec;
          } catch (_) {}
        }
      }
      hideBlockOverlay();
      return;
    }
    state.lastSkipId = null;
    renderBlockOverlay(video, resolved.blocks, tMs);
  }

  function tickDiagnostics(video) {
    if (!state.enabled) return;
    var diag = !video
      ? "no-video"
      : !state.itemId
        ? "no-item-id"
        : !state.muteDoc
          ? "no-doc"
          : "ready";
    if (diag === state.lastTickDiag) return;
    state.lastTickDiag = diag;
    if (diag === "no-video" && /#\/video/i.test(location.hash || "")) {
      warnOnce("no-video", "video element not found on #/video route");
    } else if (diag === "no-item-id" && video) {
      warnOnce("no-item-id", "could not resolve Jellyfin item id during playback");
    } else if (diag === "ready") {
      log(
        "mute loop ready",
        state.mutes.length,
        "ranges for",
        shortId(state.itemId)
      );
    }
  }

  function tick(forceRefresh) {
    try {
      var video = findVideo();
      if (video !== state.hookedVideo) {
        hookVideoLifecycle(video);
      }
      refreshPlaybackItem(video, !!forceRefresh);

      // Quarantine: on the video route, do nothing filter-related until armed.
      // This keeps browser startup identical to JMP (no mute fetch / no Web Audio).
      if (isVideoHash() && !state.filtersArmed) {
        hideBlockOverlay();
        tickDiagnostics(video);
        return;
      }

      if (!state.enabled) {
        if (state.weMuted) applyMute(video, false);
        hideBlockOverlay();
        state.lastSkipId = null;
        tickDiagnostics(video);
        return;
      }

      if (
        state.filtersArmed &&
        video &&
        state.itemId &&
        !state.muteDoc &&
        !state.fetchPending[cacheKey(state.itemId)]
      ) {
        ensureMutes(state.itemId, false);
      }

      if (!video) {
        if (state.weMuted) applyMute(null, false);
        hideBlockOverlay();
        tickDiagnostics(video);
        return;
      }

      if (video.readyState < MIN_READY) {
        tickDiagnostics(video);
        return;
      }

      var tMs = playbackMs(video);
      var hasAudio = state.mutes && state.mutes.length;
      applyMute(video, !!(hasAudio && inMuteRange(tMs, state.mutes)));
      applyViewFilter(video, tMs);
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
        disarmFilters("playbackstart");
        schedulePlaybackSettle();
        // Arm only after stable play — do not fetch/mute on start.
        scheduleFilterArm();
        tick(true);
      });
      Events.on(pm, "playbackstop", function () {
        if (state.weMuted && state.video) applyMute(state.video, false);
        // Keep any existing AudioContext connected at gain=1 — closing it can
        // permanently silence a reused <video> element in Chromium.
        if (state.audioGraph && state.audioGraph.gain) {
          setGainValue(state.audioGraph, 1);
        }
        state.weMuted = false;
        clearBlockOverlay();
        unhookVideoLifecycle();
        disarmFilters("playbackstop");
        state.lastSkipId = null;
        if (!findVideo()) {
          state.video = null;
          state.itemId = null;
          state.itemIdSource = null;
          state.mutes = [];
          state.viewFilter = { block: [], skip: [] };
          state.muteDoc = null;
          state.muteKey = null;
        }
      });
      Events.on(pm, "playerchange", function () {
        disarmFilters("playerchange");
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
      // Only for details UI — never call tick() here. Jellyfin's player mutates
      // the DOM heavily; observing + querying video on every mutation freezes startup.
      var obs = new MutationObserver(function () {
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
      hookHistory();
      ensurePlaybackHooks();
      observeDom();
      mountDetailsPanel();
      setInterval(tick, POLL_MS);
      tick();
      // Pull account prefs once auth is ready (retries briefly after login).
      var prefsAttempts = 0;
      var prefsTimer = setInterval(function () {
        prefsAttempts++;
        // Wait until ApiClient has a live token — credentials-only can be stale ("Invalid token").
        var c = apiClient();
        var live = false;
        try {
          live = !!(c && typeof c.accessToken === "function" && c.accessToken());
        } catch (_) {}
        if (!live) {
          if (prefsAttempts >= 60) clearInterval(prefsTimer);
          return;
        }
        clearInterval(prefsTimer);
        loadPrefsFromServer().then(function () {
          mountDetailsPanel();
          tick();
        });
      }, 250);
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
