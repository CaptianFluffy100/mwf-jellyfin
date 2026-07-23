/**
 * Media Word Filter — Jellyfin Web client (server plugin).
 * Same mute contract as clients/jms: half-open [start_ms, end_ms) via video.muted.
 * APIs are same-origin under /MediaWordFilter/… (proxied by the C# plugin).
 */
(function () {
  if (window.__MWF_CLIENT_LOADED__) return;
  window.__MWF_CLIENT_LOADED__ = true;

  var FLAGS = window.__MWF_PLUGIN__ || {
    enableDetailsUi: true,
    enableOsdUi: true,
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
    userId: null,
    mutes: [],
    muteKey: null,
    weMuted: false,
    userWasMuted: false,
    video: null,
    cache: Object.create(null),
    fetchPending: Object.create(null),
    detailsMountedFor: null,
    osdBtn: null,
    osdPop: null
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
    return window.ApiClient || (window.ApiClient && window.ApiClient) || null;
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
    var base = (c && c.serverAddress()) || location.origin;
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

  function fillProfileSelect(sel) {
    if (!sel) return;
    var curUser = currentUserId() || "";
    var selected = state.profileUserId || curUser;
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
      var name = p.display_name || p.displayName || shortId(id);
      opt.textContent = name;
      sel.appendChild(opt);
    }

    // If sticky profile matches an option, select it; else leave "" (current user)
    if (state.profileUserId) {
      sel.value = state.profileUserId;
      if (sel.value !== state.profileUserId) {
        // profile missing from list — keep sticky via a synthetic option
        var syn = document.createElement("option");
        syn.value = state.profileUserId;
        syn.textContent = "Profile " + shortId(state.profileUserId);
        sel.appendChild(syn);
        sel.value = state.profileUserId;
      }
    } else {
      sel.value = "";
    }

    // Avoid unused var warning in some linters
    void selected;
  }

  function shortId(id) {
    var n = normalizeItemId(id) || String(id);
    return n.slice(0, 8);
  }

  function syncUiControls() {
    try {
      document.querySelectorAll("select.mwf-profile-select").forEach(fillProfileSelect);
      document.querySelectorAll("input.mwf-filter-toggle").forEach(function (el) {
        el.checked = !!state.enabled;
      });
      if (state.osdBtn && document.body.contains(state.osdBtn)) {
        state.osdBtn.classList.toggle("mwf-active", !!state.enabled);
        state.osdBtn.setAttribute("title", state.enabled ? "MWF filter on" : "MWF filter off");
      }
    } catch (_) {}
  }

  /* ---------- Details page UI ---------- */

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

  /* ---------- OSD (conservative — do not thrash player chrome) ---------- */

  function findOsdButtonHost() {
    // Only attach to the native Jellyfin button row. Never invent a host or
    // touch Media Bar Enhanced / unknown containers (that can hide the bar).
    return (
      document.querySelector(".videoOsdBottom-buttons") ||
      document.querySelector(".videoOsdBottom .buttons") ||
      document.querySelector(".htmlvideoplayer-osdbottom .buttons") ||
      null
    );
  }

  function closeOsdPopover() {
    if (state.osdPop) {
      try {
        state.osdPop.remove();
      } catch (_) {}
      state.osdPop = null;
    }
  }

  function openOsdPopover(btn) {
    closeOsdPopover();
    var pop = document.createElement("div");
    pop.className = "mwf-osd-popover";
    pop.innerHTML =
      '<p class="mwf-pop-title">Media Word Filter</p>' +
      '<div class="mwf-pop-row"><label>Profile</label>' +
      '<select class="mwf-profile-select"></select></div>' +
      '<div class="mwf-pop-row"><label class="mwf-toggle">' +
      '<input type="checkbox" class="mwf-filter-toggle" /> Use filter</label></div>';

    // Position relative to the button, not by rewriting OSD layout styles.
    var host = btn.parentElement || document.body;
    host.appendChild(pop);
    state.osdPop = pop;

    var sel = pop.querySelector("select.mwf-profile-select");
    var chk = pop.querySelector("input.mwf-filter-toggle");
    loadProfiles().then(function () {
      fillProfileSelect(sel);
      chk.checked = !!state.enabled;
    });
    sel.addEventListener("change", function () {
      writeProfile(sel.value || "");
    });
    chk.addEventListener("change", function () {
      writeEnabled(chk.checked);
    });

    setTimeout(function () {
      function onDoc(ev) {
        if (!pop.contains(ev.target) && ev.target !== btn) {
          closeOsdPopover();
          document.removeEventListener("click", onDoc, true);
        }
      }
      document.addEventListener("click", onDoc, true);
    }, 0);
  }

  function mountOsdButton() {
    if (!FLAGS.enableOsdUi) return;
    try {
      var host = findOsdButtonHost();
      if (!host) {
        if (state.osdBtn && !document.body.contains(state.osdBtn)) {
          state.osdBtn = null;
        }
        return;
      }
      if (state.osdBtn && host.contains(state.osdBtn)) return;

      // Plain button only — do NOT set is="paper-icon-button-light" after createElement;
      // that breaks custom-element upgrades and can wreck the whole OSD row.
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "paper-icon-button-light mwf-osd-btn";
      btn.setAttribute("title", "Media Word Filter");
      btn.setAttribute("aria-label", "Media Word Filter");
      btn.innerHTML = '<span class="material-icons" aria-hidden="true">volume_off</span>';
      btn.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.osdPop) closeOsdPopover();
        else openOsdPopover(btn);
      });

      state._mwfDomQuiet = true;
      host.appendChild(btn);
      state.osdBtn = btn;
      state._mwfDomQuiet = false;
      syncUiControls();
    } catch (err) {
      state._mwfDomQuiet = false;
      log("mountOsdButton error", err);
    }
  }

  /* ---------- Prefetch next episode ---------- */

  function prefetchNextEpisode(itemId) {
    if (!FLAGS.enablePrefetch || !state.enabled) return;
    var c = apiClient();
    var userId = currentUserId();
    if (!c || !userId || !itemId || typeof c.getItem !== "function") return;

    c.getItem(userId, itemId)
      .then(function (item) {
        if (!item || item.Type !== "Episode") return null;
        var seriesId = item.SeriesId;
        var seasonId = item.SeasonId;
        var index = Number(item.IndexNumber);
        if (!seriesId || !Number.isFinite(index)) return null;

        // Prefer episodes of same season with IndexNumber + 1
        if (seasonId && typeof c.getItems === "function") {
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
        }

        if (typeof c.getNextUpEpisodes === "function") {
          return c.getNextUpEpisodes({ UserId: userId, SeriesId: seriesId, Limit: 1 }).then(function (r) {
            var items = (r && r.Items) || [];
            return items[0] && items[0].Id ? normalizeItemId(items[0].Id) : null;
          });
        }
        return null;
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

  /* ---------- Mute tick ---------- */

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
        if (state.weMuted && video) {
          applyMute(video, false);
        }
        if (itemId) {
          ensureMutes(itemId, false).then(function () {
            prefetchNextEpisode(itemId);
          });
        } else {
          state.mutes = [];
        }
      }

      // Do NOT remount OSD every poll — that fights Jellyfin / Media Bar Enhanced.

      if (!video || !state.enabled || !state.mutes || !state.mutes.length) {
        if (state.weMuted) applyMute(video, false);
        return;
      }

      var t = playbackMs(video);
      applyMute(video, inMuteRange(t, state.mutes));
    } catch (err) {
      log("tick error", err);
    }
  }

  function hookHistory() {
    var fire = function () {
      state.detailsMountedFor = null;
      state.osdBtn = null;
      closeOsdPopover();
      setTimeout(function () {
        mountDetailsPanel();
        mountOsdButton();
        tick();
      }, 100);
    };
    try {
      var origPush = history.pushState.bind(history);
      var origReplace = history.replaceState.bind(history);
      history.pushState = function () {
        var ret = origPush.apply(history, arguments);
        fire();
        return ret;
      };
      history.replaceState = function () {
        var ret = origReplace.apply(history, arguments);
        fire();
        return ret;
      };
      window.addEventListener("popstate", fire);
      window.addEventListener("hashchange", fire);
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
          state.osdBtn = null;
          setTimeout(function () {
            mountOsdButton();
            tick();
          }, 300);
        });
        Events.on(pm, "playbackstop", function () {
          closeOsdPopover();
          if (state.weMuted && state.video) applyMute(state.video, false);
          state.osdBtn = null;
        });
        Events.on(pm, "playerchange", function () {
          state.itemId = null;
          state.osdBtn = null;
          setTimeout(mountOsdButton, 300);
        });
      }
    } catch (_) {}
  }

  function observeDom() {
    var timer = null;
    var obs = new MutationObserver(function () {
      if (state._mwfDomQuiet) return;
      if (timer) clearTimeout(timer);
      // Debounce heavily — continuous OSD rebuild loops hide the media bar.
      timer = setTimeout(function () {
        timer = null;
        mountDetailsPanel();
        mountOsdButton();
      }, 400);
    });
    try {
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
      log("client ready", FLAGS);
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
