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
    { re: new RegExp("/Items/(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("/Items/(" + GUID_FLAT + ")", "i") },
    { re: new RegExp("/Videos/(" + GUID_DASHED + ")", "i") },
    { re: new RegExp("/Videos/(" + GUID_FLAT + ")", "i") },
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

  var state = {
    enabled: readEnabled(),
    profileUserId: readProfile(),
    profiles: [],
    profilesLoaded: false,
    itemId: null,
    mutes: [],
    muteKey: null,
    weMuted: false,
    userWasMuted: false,
    video: null,
    cache: Object.create(null),
    fetchPending: Object.create(null),
    detailsMountedFor: null
  };

  function log() {
    if (!window.__MWF_DEBUG__) return;
    var args = ["[mwf-plugin]"].concat(Array.prototype.slice.call(arguments));
    console.log.apply(console, args);
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
    return window.ApiClient || null;
  }

  function authHeaders() {
    var c = apiClient();
    var headers = { Accept: "application/json" };
    try {
      if (c && typeof c.getAccessToken === "function") {
        var tok = c.getAccessToken();
        if (tok) headers["X-Emby-Token"] = tok;
      }
    } catch (_) {}
    return headers;
  }

  function apiUrl(path) {
    var c = apiClient();
    if (c && typeof c.getUrl === "function") {
      return c.getUrl(path.replace(/^\//, ""));
    }
    var base = (c && c.serverAddress && c.serverAddress()) || location.origin;
    return String(base).replace(/\/+$/, "") + "/" + path.replace(/^\//, "");
  }

  function fetchJson(path) {
    return fetch(apiUrl(path), {
      credentials: "same-origin",
      headers: authHeaders()
    }).then(function (res) {
      if (res.status === 404) return null;
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

  function playbackItemId() {
    try {
      var pm = window.PlaybackManager;
      if (pm) {
        if (typeof pm.getCurrentPlayer === "function") {
          var player = pm.getCurrentPlayer();
          if (player) {
            if (player._currentItem && player._currentItem.Id) {
              var a = normalizeItemId(player._currentItem.Id);
              if (a) return a;
            }
            if (typeof player.getCurrentItem === "function") {
              var it = player.getCurrentItem();
              if (it && it.Id) {
                var b = normalizeItemId(it.Id);
                if (b) return b;
              }
            }
          }
        }
        if (typeof pm.currentItem === "function") {
          var cur = pm.currentItem();
          if (cur && cur.Id) {
            var c = normalizeItemId(cur.Id);
            if (c) return c;
          }
        }
        if (pm._currentItem && pm._currentItem.Id) {
          var d = normalizeItemId(pm._currentItem.Id);
          if (d) return d;
        }
      }
    } catch (_) {}

    try {
      var c2 = apiClient();
      if (c2 && typeof c2.getCurrentItemId === "function") {
        var e = normalizeItemId(c2.getCurrentItemId());
        if (e) return e;
      }
    } catch (_) {}

    return extractFromString(location.href) || extractFromString(location.hash);
  }

  function findVideo() {
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
    if (!force && state.muteKey === key && state.mutes) {
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

    var uid = effectiveProfileUserId();
    var path = "MediaWordFilter/mutes/" + encodeURIComponent(itemId);
    if (uid) path += "?user_id=" + encodeURIComponent(uid);

    var p = fetchJson(path)
      .then(function (doc) {
        var mutes = doc ? parseMuteDocument(doc) : [];
        state.cache[key] = { mutes: mutes, fetchedAt: Date.now() };
        state.mutes = mutes;
        state.muteKey = key;
        log("loaded", mutes.length, "mutes for", itemId);
        return mutes;
      })
      .catch(function (err) {
        log("mute fetch failed", err);
        state.mutes = [];
        state.muteKey = key;
        return [];
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

      if (itemId) ensureMutes(itemId, false);
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
    if (!video) return;
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

  function tick() {
    try {
      var video = findVideo();
      state.video = video;

      var itemId = playbackItemId();
      if (itemId !== state.itemId) {
        state.itemId = itemId;
        state.muteKey = null;
        if (state.weMuted && video) applyMute(video, false);
        if (itemId) {
          ensureMutes(itemId, false).then(function () {
            prefetchNextEpisode(itemId);
          });
        } else {
          state.mutes = [];
        }
      }

      if (!video || !state.enabled || !state.mutes || !state.mutes.length) {
        if (state.weMuted) applyMute(video, false);
        return;
      }

      applyMute(video, inMuteRange(playbackMs(video), state.mutes));
    } catch (err) {
      log("tick error", err);
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
    try {
      var Events = window.Events;
      var pm = window.PlaybackManager;
      if (Events && pm && typeof Events.on === "function") {
        Events.on(pm, "playbackstart", function () {
          state.itemId = null;
          tick();
        });
        Events.on(pm, "playbackstop", function () {
          if (state.weMuted && state.video) applyMute(state.video, false);
        });
        Events.on(pm, "playerchange", function () {
          state.itemId = null;
          tick();
        });
      }
    } catch (_) {}
  }

  function observeDom() {
    var timer = null;
    try {
      var obs = new MutationObserver(function () {
        if (!isDetailsHash()) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(function () {
          timer = null;
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
      hookPlaybackEvents();
      observeDom();
      mountDetailsPanel();
      setInterval(tick, POLL_MS);
      tick();
      log("client ready (no OSD injection)", FLAGS);
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
