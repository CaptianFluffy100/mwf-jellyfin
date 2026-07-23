# MWF browser extension — Jellyfin Web (JMS)

Chromium/Firefox **Manifest V3** extension that mutes filtered phrases during **Jellyfin Web** playback, using the same mute API as the [JMP mpv script](../jmp/mwf_mute.lua):

```http
GET {api_base}/mutes/{item_id}?user_id={jellyfin_user_id}
```

Mute fetches run in the extension **background service worker**, so Jellyfin’s origin never talks to MWF directly (no CORS requirement on the mute endpoint).

A **MAIN-world page bridge** (`page-bridge.js`) reads Jellyfin `PlaybackManager` / `ApiClient` and posts item/user ids to the content script (isolated world cannot see those globals).

## Install (unpacked)

### From the MWF Profiles UI (recommended)

1. Open **Profiles** → select your Jellyfin user.
2. **Download extension zip** → unpack somewhere permanent.
3. Load unpacked (steps below).
4. **Download extension config** → copy `apiBase` / `userId` into extension Options (or set them manually from Settings → Public base URL).

Zip URL: `GET /api/clients/jms.zip`  
Config URL: `GET /api/profiles/{user_id}/extension-config`

### Chrome / Edge / Brave

1. Ensure `mwf serve` is running and reachable from this machine (see [main README](../../README.md)).
2. Go to `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode**.
4. **Load unpacked** → select this folder (`clients/jms/`, or the unpacked zip).
5. Open extension Options and set **MWF api_base** (e.g. `http://192.168.1.10:8787` — use LAN IP when MWF is on another host).
6. Open Jellyfin Web, play an item that already has mute data in MWF, and confirm audio mutes on matched intervals.

Toolbar popup shows item id, mute range count, and whether a mute is active. Badge: range count when loaded, **M** while muted.

### Firefox

1. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
2. Choose `manifest.json` in this folder.
3. Configure **api_base** in Options (same as above).

Temporary add-ons are removed when Firefox restarts; reload for daily use or pack/sign for permanent install.

## Configuration (Options)

| Setting | Default | Notes |
|---------|---------|--------|
| **Enable filtering** | on | Master switch |
| **api_base** | `http://127.0.0.1:8787` | MWF HTTP base; must be reachable from the browser |
| **user_id override** | (empty) | Jellyfin user GUID for personalized mutes; auto-detected when blank |
| **item_id override** | (empty) | Debug/manual override; skips URL/playback discovery |
| **Poll interval** | 100 ms | Same order as JMP `poll_interval=0.1` |
| **Debug** | off | `[mwf-jms]` logs in the Jellyfin tab console |

Use **Test API connection** to hit `GET /health` via the background worker.

Settings are stored in `storage.sync` with a `storage.local` fallback.

## Permissions

- **storage** — save options and live status for the popup
- **host_permissions** `http://*/*`, `https://*/*` — background fetch to your MWF server; content script on your Jellyfin URL (any host/port)
- **web_accessible_resources** — `page-bridge.js` injected into the Jellyfin page MAIN world

The content script only activates on pages that look like Jellyfin (`jellyfin_credentials`, URL/hash heuristics, etc.).

## Behavior (matches JMP Lua)

- Item discovery order: override → MAIN bridge (`PlaybackManager` item **Id**) → sticky last id while video plays → trusted URL patterns only (`ItemId`, `/Items/`, `/Videos/`, `#/details?id=`). **Never** uses `MediaSourceId` / bare GUIDs (those flip per stream session).
- User id: override → bridge → `jellyfin_credentials` in local/session storage.
- Item ids normalized to lowercase undashed 32-hex (dashed GUIDs accepted).
- Mute window: `start_ms <= playback_ms < end_ms` (half-open).
- Sets `video.muted = true` only during ranges; restores prior mute state afterward (does not clear a user-initiated mute held before MWF engaged).
- Re-fetches mutes when the resolved item id changes (SPA navigation, new stream URL, playback manager item).
- Does **not** call ASR/process endpoints — read-only mute GET, same as JMP.

## Manual test checklist

1. Process an item in MWF web UI so mute ranges exist for your Jellyfin user (or default profile).
2. Set `api_base` in Options → **Test API connection** succeeds.
3. In Jellyfin Web, play that item.
4. Open extension popup — expect a resolved **item** id and **mute ranges** &gt; 0.
5. Scrub to a known muted interval — audio should cut; badge shows **M**.
6. Enable **Debug**, reload Jellyfin tab, watch console for `[mwf-jms] loaded N mute range(s)`.

If item id stays `(none)`, try **item_id override** with the Jellyfin GUID from the item details URL, or check the browser console with debug enabled.

## Limitations

- **Jellyfin Web only** — does not replace the JMP mpv script for desktop player.
- Unusual embeds or very old Jellyfin builds may need manual overrides.
- Uses HTML5 `video.muted` (browser player), not system volume.
- Firefox temporary add-ons must be reloaded after browser restart unless you sign/package the extension.
- Cast / remote players (no local `<video>`) are not supported.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest (Chromium + Firefox `browser_specific_settings`) |
| `background.js` | Service worker — `GET /mutes/…`, `/health`, toolbar badge |
| `content.js` | Isolated world — detect video, apply mutes, inject bridge |
| `page-bridge.js` | MAIN world — `PlaybackManager` / `ApiClient` snapshots |
| `lib/mwf-common.js` | Shared id normalization + mute interval logic |
| `options.html` / `options.js` | Configuration UI |
| `popup.html` / `popup.js` | Toolbar status popup |
