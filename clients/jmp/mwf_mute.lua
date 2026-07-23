-- mwf_mute.lua — Media Word Filter mute controller for Jellyfin Media Player (mpv)
--
-- Install (classic JMP / jellyfin-media-player releases):
--   JMP sets mpv's config-dir to its data dir and auto-loads scripts/ there.
--   JMP creates the data dir on first launch, but does NOT create scripts/ —
--   mkdir it yourself if missing, then copy this file in:
--
--     macOS:   ~/Library/Application Support/Jellyfin Media Player/scripts/mwf_mute.lua
--              (exact folder name with spaces; not jellyfinmediaplayer / not the
--               bundle id tv.jellyfin.player)
--     Linux:   ~/.local/share/jellyfinmediaplayer/scripts/mwf_mute.lua
--     Flatpak: ~/.var/app/com.github.iwalton3.jellyfin-media-player/data/jellyfinmediaplayer/scripts/
--     Windows: %LOCALAPPDATA%\\JellyfinMediaPlayer\\scripts\\mwf_mute.lua
--
--   Fallback if scripts/ auto-load fails: put an absolute path in that same
--   data dir's mpv.conf:
--     script=/full/path/to/mwf_mute.lua
--   Prefer the file over JMP Settings → Manual MPV Configuration on older macOS
--   builds (in-app other_conf historically crashed at startup).
--
--   Newer "Jellyfin Desktop" (rewritten client) uses a different tree, e.g.:
--     ~/Library/Application Support/Jellyfin Desktop/profiles/<name>/
--
-- Script-opts MUST live in script-opts/ (NOT scripts/):
--   macOS:  …/Jellyfin Media Player/script-opts/mwf_mute.conf
--   Putting mwf_mute.conf inside scripts/ makes mpv log
--   "Can't load unknown script: …/scripts/mwf_mute.conf" (harmless but wrong).
--
-- Config priority (highest wins):
--   1) script-opts file / mpv.conf script-opts=…  (optional override)
--   2) values baked into this file (personalized download from the web UI)
--   3) the defaults below
--
-- Prefer downloading a personalized script from the MWF Profiles page so
-- api_base + jellyfin_user_id are embedded (script-opts often fails under JMP).
--
-- Opts:
--   api_base=http://192.168.x.x:8787   # Mac JMP → LAN IP of the mwf host (NOT 127.0.0.1)
--   jellyfin_user_id=                 # Jellyfin user GUID — personalizes mute filters
--   poll_interval=0.1
--   item_id=                          # manual override; skip URL/path discovery
--   enabled=yes
--   osd_on_mute=yes                   # brief OSD when a mute range engages
--   toggle_key=Ctrl+Shift+m
--   status_key=Ctrl+Shift+i
--
-- Keys (defaults; override via script-opts):
--   Ctrl+Shift+m  — toggle filtering on/off (session only)  [Mac JMP-friendly]
--   Ctrl+Shift+i  — show status OSD
--   Alt+m / Alt+i — also bound as secondary (often stolen by macOS Option+char)
--
-- Script messages (optional external hooks):
--   script-message mwf-toggle
--   script-message mwf-status
--   script-message mwf-set-item-id <id>
--   script-message mwf-set-enabled yes|no
--   script-message mwf-reload
--
-- Verify: after restart, logs should include "mwf_mute loaded" and an OSD
--   "MWF loaded — press Ctrl+Shift+i for status".
--   macOS logs: ~/Library/Logs/Jellyfin Media Player/
--   Press Ctrl+Shift+i while playing — expect a resolved item_id and mute range
--   count > 0 for processed items. Watch for "mwf: mute on" / OSD "MWF muted".
--
-- Item-id discovery:
--   1) script-opt / runtime item_id
--   2) parse from path, stream-open-filename, media-title, playlist-path, etc.
--      (Items/Videos/Audio/{id}, ItemId=, MediaSourceId=, dashed or 32-hex GUID)
--   3) normalize to lowercase undashed id (matches mwf store layout)
--
-- Requires: curl on PATH (present on macOS). CORS does not apply (mpv→curl→API).

local utils = require("mp.utils")
local msg = require("mp.msg")
local options = require("mp.options")

local opts = {
    api_base = "http://127.0.0.1:8787",
    jellyfin_user_id = "",
    poll_interval = 0.1,
    item_id = "",
    enabled = true,
    osd_on_mute = true,
    -- Ctrl+Shift avoids macOS Option (Alt) dead-key / character input stealing Alt+m/i
    toggle_key = "Ctrl+Shift+m",
    status_key = "Ctrl+Shift+i",
}
-- script-opts file is optional and overrides baked-in / default values when present.
options.read_options(opts, "mwf_mute")

-- Hex class must include A-F: Lua %x is lowercase-only, but Jellyfin URLs often use uppercase GUIDs.
local HEX = "[0-9a-fA-F]"
local GUID_DASHED = HEX:rep(8) .. "%-" .. HEX:rep(4) .. "%-" .. HEX:rep(4)
    .. "%-" .. HEX:rep(4) .. "%-" .. HEX:rep(12)
local GUID_FLAT = HEX:rep(32)

local state = {
    enabled = opts.enabled,
    item_id = nil,          -- normalized (lowercase, no dashes)
    item_id_raw = nil,      -- as found (for OSD)
    mutes = {},
    we_muted = false,       -- true only while *this script* holds mute on
    last_path = nil,
    fetch_pending = false,
    last_error = nil,
    warned_no_id = false,
    warned_no_mutes = false,
    warned_fetch_fail = false,
    osd_muted_shown = false,
    manual_item_id = nil,   -- runtime override (script-message / opts)
}

if opts.item_id and opts.item_id ~= "" then
    state.manual_item_id = opts.item_id
end

local function trim_slash(s)
    return (s:gsub("/+$", ""))
end

local function osd(text, seconds)
    seconds = seconds or 3
    mp.osd_message(text, seconds)
end

local function set_error(err)
    state.last_error = err
    if err then
        msg.warn("mwf: " .. err)
    end
end

--- Normalize Jellyfin ids to the form used in the mwf store (32 lowercase hex, no dashes).
local function normalize_item_id(id)
    if not id or id == "" then
        return nil
    end
    local flat = id:gsub("%s+", ""):gsub("%-", ""):lower()
    if #flat == 32 and flat:match("^[0-9a-f]+$") then
        return flat
    end
    -- Keep non-GUID keys as-is (lowercased, no dashes) for manual debugging
    if #flat >= 8 then
        return flat
    end
    return nil
end

local function url_decode(s)
    if not s then
        return s
    end
    s = s:gsub("+", " ")
    s = s:gsub("%%([0-9a-fA-F][0-9a-fA-F])", function(h)
        return string.char(tonumber(h, 16))
    end)
    return s
end

--- Try to pull an item id from a single string (URL, path, title, …).
--- Prefer route / query ItemId over MediaSourceId / bare GUID / playSessionId.
local function extract_from_string(s)
    if not s or s == "" then
        return nil, nil
    end
    local text = url_decode(s)

    local patterns = {
        -- Explicit item id query params (highest trust)
        { "[%?&#]ItemId=(" .. GUID_DASHED .. ")", "ItemId" },
        { "[%?&#]ItemId=(" .. GUID_FLAT .. ")", "ItemId" },
        { "[%?&#]itemId=(" .. GUID_DASHED .. ")", "itemId" },
        { "[%?&#]itemId=(" .. GUID_FLAT .. ")", "itemId" },
        { "[%?&#]item_id=(" .. GUID_DASHED .. ")", "item_id" },
        { "[%?&#]item_id=(" .. GUID_FLAT .. ")", "item_id" },
        -- Jellyfin path segments — item id is the route guid
        { "/Items/(" .. GUID_DASHED .. ")", "Items/" },
        { "/Items/(" .. GUID_FLAT .. ")", "Items/" },
        { "/Videos/(" .. GUID_DASHED .. ")", "Videos/" },
        { "/Videos/(" .. GUID_FLAT .. ")", "Videos/" },
        { "/Audio/(" .. GUID_DASHED .. ")", "Audio/" },
        { "/Audio/(" .. GUID_FLAT .. ")", "Audio/" },
        -- mediaSourceId often equals item id for single-version files
        { "[%?&#]MediaSourceId=(" .. GUID_DASHED .. ")", "MediaSourceId" },
        { "[%?&#]MediaSourceId=(" .. GUID_FLAT .. ")", "MediaSourceId" },
        { "[%?&#]mediaSourceId=(" .. GUID_DASHED .. ")", "mediaSourceId" },
        { "[%?&#]mediaSourceId=(" .. GUID_FLAT .. ")", "mediaSourceId" },
        { "[%?&#]id=(" .. GUID_DASHED .. ")", "id=" },
        { "[%?&#]id=(" .. GUID_FLAT .. ")", "id=" },
    }

    for _, entry in ipairs(patterns) do
        local id = text:match(entry[1])
        if id then
            local norm = normalize_item_id(id)
            if norm then
                return norm, id
            end
        end
    end

    -- Bare dashed GUID anywhere (route/query patterns above already preferred)
    local bare = text:match("(" .. GUID_DASHED .. ")")
    if bare then
        local norm = normalize_item_id(bare)
        if norm then
            return norm, bare
        end
    end

    -- Bare 32-hex with non-hex boundaries (avoids eating longer hex strings)
    local _, flat32 = text:match("([^0-9a-fA-F]|^)(" .. GUID_FLAT .. ")([^0-9a-fA-F]|$)")
    if flat32 then
        local norm = normalize_item_id(flat32)
        if norm then
            return norm, flat32
        end
    end

    return nil, nil
end

local function discovery_sources()
    local props = {
        "path",
        "stream-open-filename",
        "playlist-path",
        "media-title",
        "force-media-title",
        "filename",
        "filename/no-ext",
    }
    local out = {}
    for _, p in ipairs(props) do
        local v = mp.get_property(p)
        if v and v ~= "" then
            table.insert(out, { prop = p, value = v })
        end
    end
    local meta = mp.get_property_native("metadata")
    if type(meta) == "table" then
        for k, v in pairs(meta) do
            if type(v) == "string" and v ~= "" then
                local key = tostring(k):lower()
                if key:find("id", 1, true) or key:find("jelly", 1, true) or key:find("guid", 1, true) then
                    table.insert(out, { prop = "metadata." .. tostring(k), value = v })
                end
            end
        end
    end
    return out
end

local function resolve_item_id()
    if state.manual_item_id and state.manual_item_id ~= "" then
        local norm = normalize_item_id(state.manual_item_id) or state.manual_item_id:lower():gsub("%-", "")
        return norm, state.manual_item_id, "manual"
    end

    local sources = discovery_sources()
    for _, src in ipairs(sources) do
        local norm, raw = extract_from_string(src.value)
        if norm then
            msg.verbose(string.format("mwf: id from %s → %s (raw %s)", src.prop, norm, tostring(raw)))
            return norm, raw, src.prop
        end
    end

    -- Log what we saw so Mac users can debug without guessing
    msg.warn("mwf: no item id — inspected:")
    for _, src in ipairs(sources) do
        local preview = src.value
        if #preview > 180 then
            preview = preview:sub(1, 180) .. "…"
        end
        msg.warn(string.format("mwf:   %s=%s", src.prop, preview))
    end
    if #sources == 0 then
        msg.warn("mwf:   (no path/title properties available yet)")
    end
    return nil, nil, nil
end

local function apply_mute(want)
    if want then
        if not state.we_muted then
            mp.set_property_native("mute", true)
            state.we_muted = true
            msg.info("mwf: mute on")
            if opts.osd_on_mute and not state.osd_muted_shown then
                -- osd("MWF muted", 1.2)
                state.osd_muted_shown = true
            end
        elseif not mp.get_property_native("mute") then
            -- Re-assert if something unmuted us mid-range
            mp.set_property_native("mute", true)
        end
        return
    end
    -- Only clear mute if we turned it on (don't clear a pre-existing user mute)
    if state.we_muted then
        mp.set_property_native("mute", false)
        state.we_muted = false
        state.osd_muted_shown = false
        msg.info("mwf: mute off")
    end
end

local function status_text()
    local id = state.item_id or "(missing)"
    local raw = state.item_id_raw and (" raw=" .. state.item_id_raw) or ""
    local err = state.last_error or "none"
    local uid = (opts.jellyfin_user_id and opts.jellyfin_user_id ~= "") and opts.jellyfin_user_id or "(default)"
    local lines = {
        "MWF filter: " .. (state.enabled and "ON" or "OFF"),
        "item_id: " .. id .. raw,
        "user_id: " .. uid,
        "api_base: " .. opts.api_base,
        "mute ranges: " .. tostring(#state.mutes),
        "currently muted: " .. (state.we_muted and "yes" or "no"),
        "last error: " .. err,
        "keys: " .. opts.toggle_key .. " toggle, " .. opts.status_key .. " status",
    }
    return table.concat(lines, "\n")
end

local function show_status()
    local text = status_text()
    osd.info("mwf status:\n" .. text, 0.5)
    osd(text, 5)
end

local function on_mutes_fetched(ok, http_status, body, err)
    state.fetch_pending = false
    if not ok then
        set_error("fetch failed: " .. tostring(err) .. " (check api_base=" .. opts.api_base .. ")")
        state.mutes = {}
        if not state.warned_fetch_fail then
            osd("mwf: API unreachable — check api_base", 4)
            state.warned_fetch_fail = true
        end
        return
    end
    if http_status == 404 then
        set_error("no mute data for item " .. tostring(state.item_id))
        state.mutes = {}
        if not state.warned_no_mutes then
            osd("mwf: no mute data", 3)
            state.warned_no_mutes = true
        end
        return
    end
    if http_status ~= 200 then
        set_error(string.format("HTTP %s body=%s", tostring(http_status), tostring(body):sub(1, 200)))
        state.mutes = {}
        if not state.warned_fetch_fail then
            osd("mwf: bad API response HTTP " .. tostring(http_status), 4)
            state.warned_fetch_fail = true
        end
        return
    end
    local parsed_ok, data = pcall(utils.parse_json, body)
    if not parsed_ok or type(data) ~= "table" then
        set_error("invalid JSON from mute API")
        state.mutes = {}
        return
    end
    local list = data.mutes or {}
    state.mutes = {}
    for _, m in ipairs(list) do
        -- mpv JSON may yield numbers; tolerate stringified ms too
        local start_ms = tonumber(m.start_ms)
        local end_ms = tonumber(m.end_ms)
        if start_ms and end_ms then
            table.insert(state.mutes, {
                start_ms = start_ms,
                end_ms = end_ms,
            })
        end
    end
    state.last_error = nil
    state.warned_no_mutes = false
    state.warned_fetch_fail = false
    msg.info(string.format("mwf: loaded %d mute range(s) for %s", #state.mutes, tostring(state.item_id)))
    if #state.mutes == 0 then
        set_error("API returned 0 mute ranges")
        if not state.warned_no_mutes then
            osd("mwf: no mute data", 3)
            state.warned_no_mutes = true
        end
    end
end

local function fetch_mutes(item_id)
    if state.fetch_pending then
        return
    end
    state.fetch_pending = true
    local url = string.format("%s/mutes/%s", trim_slash(opts.api_base), item_id)
    if opts.jellyfin_user_id and opts.jellyfin_user_id ~= "" then
        url = url .. "?user_id=" .. opts.jellyfin_user_id
    end
    msg.info("mwf: GET " .. url)

    -- Write body to stdout; append HTTP code on the last line (avoid curl -f so 404 is visible).
    local cmd = {
        "curl", "-sS", "--max-time", "5",
        "-H", "Accept: application/json",
        "-w", "\n%{http_code}",
        url,
    }
    -- Callback is fn(success, result, error) — NOT fn(result). Treating the first
    -- arg as a table crashes with: attempt to index local 'res' (a boolean value)
    -- and mute ranges never load (seen on Mac JMP / mpv 0.39).
    mp.command_native_async({
        name = "subprocess",
        args = cmd,
        capture_stdout = true,
        capture_stderr = true,
        playback_only = false,
    }, function(success, res, err)
        if not success then
            local detail = tostring(err or "subprocess error")
            if type(res) == "table" and res.stderr and res.stderr ~= "" then
                detail = detail .. " " .. res.stderr
            end
            on_mutes_fetched(false, nil, nil, detail)
            return
        end
        if type(res) ~= "table" then
            on_mutes_fetched(false, nil, nil, err or "empty subprocess result")
            return
        end
        if res.error then
            local detail = tostring(res.error)
            if res.stderr and res.stderr ~= "" then
                detail = detail .. " " .. res.stderr
            end
            on_mutes_fetched(false, nil, nil, detail)
            return
        end
        if res.status and res.status ~= 0 then
            local detail = "curl exit " .. tostring(res.status)
            if res.stderr and res.stderr ~= "" then
                detail = detail .. ": " .. res.stderr
            end
            on_mutes_fetched(false, nil, nil, detail)
            return
        end
        local out = res.stdout or ""
        -- Prefer last line as HTTP code (curl -w appends \n%{http_code})
        local body, code_s = out:match("^(.*)\n(%d%d%d)%s*$")
        if not body then
            -- Fallback: last 3 digits of stdout
            code_s = out:match("(%d%d%d)%s*$")
            if code_s then
                body = out:sub(1, #out - #code_s):gsub("\n$", "")
            else
                on_mutes_fetched(false, nil, nil, "could not parse HTTP status from curl")
                return
            end
        end
        on_mutes_fetched(true, tonumber(code_s) or 0, body, nil)
    end)
end

local function refresh_item_if_needed(force)
    local path = mp.get_property("path") or ""
    local stream = mp.get_property("stream-open-filename") or ""
    local fingerprint = path .. "\0" .. stream .. "\0" .. tostring(state.manual_item_id or "")
    if not force and fingerprint == state.last_path then
        return
    end
    state.last_path = fingerprint
    apply_mute(false)
    state.mutes = {}
    state.warned_no_id = false
    state.warned_no_mutes = false
    state.warned_fetch_fail = false
    state.osd_muted_shown = false

    local id, raw, source = resolve_item_id()
    state.item_id = id
    state.item_id_raw = raw
    if id then
        msg.info(string.format("mwf: resolved item id %s (from %s, raw=%s)", id, tostring(source), tostring(raw)))
        state.last_error = nil
        fetch_mutes(id)
    else
        set_error("could not resolve Jellyfin item id; set script-opt item_id=… or script-message mwf-set-item-id")
        if not state.warned_no_id then
            osd("mwf: no item id — press " .. opts.status_key .. " for details", 4)
            state.warned_no_id = true
        end
    end
end

-- time-pos is seconds (float); mute JSON uses milliseconds.
local function playback_ms()
    local t = mp.get_property_number("time-pos", 0) or 0
    return math.floor(t * 1000 + 0.5)
end

local function in_range(t_ms, ranges)
    for _, r in ipairs(ranges) do
        if t_ms >= r.start_ms and t_ms < r.end_ms then
            return true
        end
    end
    return false
end

local function tick()
    if not state.enabled then
        apply_mute(false)
        return
    end
    refresh_item_if_needed(false)
    if not state.item_id or #state.mutes == 0 then
        apply_mute(false)
        return
    end
    apply_mute(in_range(playback_ms(), state.mutes))
end

local function toggle_enabled()
    state.enabled = not state.enabled
    if not state.enabled then
        apply_mute(false)
    end
    local s = state.enabled and "ON" or "OFF"
    msg.info("mwf: filtering " .. s)
    osd("MWF filtering " .. s, 2)
end

local function set_enabled(val)
    local on = false
    if type(val) == "boolean" then
        on = val
    else
        local s = tostring(val or ""):lower()
        on = (s == "yes" or s == "true" or s == "1" or s == "on")
    end
    state.enabled = on
    if not state.enabled then
        apply_mute(false)
    end
    osd("MWF filtering " .. (state.enabled and "ON" or "OFF"), 2)
end

local function set_item_id_manual(id)
    if not id or id == "" then
        state.manual_item_id = nil
        osd("mwf: cleared manual item_id", 2)
    else
        state.manual_item_id = id
        osd("mwf: item_id=" .. id, 2)
    end
    state.last_path = nil
    refresh_item_if_needed(true)
end

local announced = false
local function announce_loaded()
    if announced then
        return
    end
    announced = true
    osd("MWF loaded — press " .. opts.status_key .. " for status", 5)
end

local poll = tonumber(opts.poll_interval) or 0.1
if poll < 0.05 then
    poll = 0.05
end
mp.add_periodic_timer(poll, tick)
mp.register_event("file-loaded", function()
    announce_loaded()
    state.last_path = nil
    refresh_item_if_needed(true)
end)
mp.register_event("end-file", function()
    apply_mute(false)
    state.mutes = {}
    state.item_id = nil
    state.item_id_raw = nil
    state.last_path = nil
    state.last_error = nil
end)

-- JMP may set path/stream URL after file-loaded; re-resolve when they change.
mp.observe_property("path", "string", function()
    refresh_item_if_needed(false)
end)
mp.observe_property("stream-open-filename", "string", function()
    refresh_item_if_needed(false)
end)

-- Forced so JMP UI keybinds don't swallow MWF keys. Primary defaults are
-- Ctrl+Shift+… (Mac-friendly); keep Alt+m / Alt+i as secondary when different.
local function bind_key(key, name, fn)
    if key and key ~= "" then
        mp.add_forced_key_binding(key, name, fn)
    end
end
bind_key(opts.toggle_key, "mwf-toggle", toggle_enabled)
bind_key(opts.status_key, "mwf-status", show_status)
if opts.toggle_key ~= "ALT+m" and opts.toggle_key ~= "Alt+m" then
    bind_key("ALT+m", "mwf-toggle-alt", toggle_enabled)
end
if opts.status_key ~= "ALT+i" and opts.status_key ~= "Alt+i" then
    bind_key("ALT+i", "mwf-status-alt", show_status)
end

mp.register_script_message("mwf-toggle", toggle_enabled)
mp.register_script_message("mwf-status", show_status)
mp.register_script_message("mwf-set-item-id", set_item_id_manual)
mp.register_script_message("mwf-set-enabled", set_enabled)
mp.register_script_message("mwf-reload", function()
    state.last_path = nil
    refresh_item_if_needed(true)
end)

msg.info(string.format(
    "mwf_mute loaded (api_base=%s user_id=%s enabled=%s keys=%s/%s)",
    opts.api_base,
    (opts.jellyfin_user_id ~= "" and opts.jellyfin_user_id) or "(default)",
    tostring(state.enabled),
    opts.toggle_key,
    opts.status_key
))
-- Loud startup cue so Mac users know the script is alive (also on first file-loaded).
mp.add_timeout(2.0, announce_loaded)
if opts.api_base:find("127%.0%.0%.1", 1, false) or opts.api_base:find("localhost", 1, true) then
    msg.warn("mwf: api_base points at localhost — on a Mac talking to a remote host (e.g. Beast), set script-opts api_base=http://<LAN-IP>:8787")
end
