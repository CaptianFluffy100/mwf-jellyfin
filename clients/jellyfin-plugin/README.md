# Media Word Filter — Jellyfin server plugin

C# plugin for **Jellyfin 10.11.x** that brings Media Word Filter muting into **Jellyfin Web** without a browser extension:

- Details page (`#/details?id=…`): profile + filter on/off controls under the Audio selector
- Playback OSD: button to change the same settings while watching
- Auto-fetches mute ranges for the current item and **prefetches** the next episode
- Admin configures the MWF base URL once; users never type an MWF URL (same-origin `/MediaWordFilter/…` proxy)

JMP (`clients/jmp`) and the browser extension (`clients/jms`) remain for non-web clients.

## Requirements

1. **Jellyfin Server 10.11.x** (plugin targets `net9.0` / Jellyfin ABI 10.11; built against **10.11.4**)
2. **[File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation)**  
   Repository: `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`  
   Without FT, the injected client script will not load (Dashboard config still works).
3. A reachable **Media Word Filter** HTTP service (e.g. `http://mwf:8787` on Docker)

## Packaging files Jellyfin expects

| File | Role |
|------|------|
| [`manifest.json`](manifest.json) | **Plugin repository catalog** — add this URL under Dashboard → Plugins → Repositories |
| [`Jellyfin.Plugin.MediaWordFilter/meta.json`](Jellyfin.Plugin.MediaWordFilter/meta.json) | Packed **inside** the release zip next to the DLL |

`versions[].sourceUrl` in `manifest.json` must point at a hosted zip; `checksum` is the **MD5** of that zip (filled by `build.sh`).

## Build

From this directory (uses the official .NET 8 SDK container — no host SDK required):

```bash
chmod +x build.sh
./build.sh
```

Produces:

- `dist/jellyfin-plugin-mediawordfilter_1.0.0.0.zip` (DLL + `meta.json`)
- Updated `manifest.json` checksum

Or with a local SDK:

```bash
dotnet build Jellyfin.Plugin.MediaWordFilter/Jellyfin.Plugin.MediaWordFilter.csproj -c Release
```

## Install

### Via repository (preferred)

1. Host `dist/jellyfin-plugin-mediawordfilter_*.zip` somewhere Jellyfin can download (HTTPS).
2. Set `versions[0].sourceUrl` in [`manifest.json`](manifest.json) to that zip URL (checksum already set by `build.sh`).
3. Host `manifest.json` and add its URL in Jellyfin → Dashboard → Plugins → **Repositories**.
4. Catalog → install **Media Word Filter**.
5. Also install **File Transformation** (repo: `https://www.iamparadox.dev/jellyfin/plugins/manifest.json`).

### Manual (DLL / zip)

1. Install **File Transformation**, then restart Jellyfin if prompted.
2. Unzip `dist/jellyfin-plugin-mediawordfilter_*.zip` into a plugin folder, e.g.:
   - Docker: `/config/plugins/MediaWordFilter/`
   - Linux: `/var/lib/jellyfin/plugins/MediaWordFilter/`
   (folder must contain `Jellyfin.Plugin.MediaWordFilter.dll` and `meta.json`)
3. Restart Jellyfin.

### Configure

4. Dashboard → **Plugins** → **Media Word Filter**:
   - Set **MWF base URL** (e.g. `http://192.168.1.10:8787` or Docker service name)
   - Click **Test MWF connection**
   - Save
5. Hard-refresh Jellyfin Web (`Ctrl+Shift+R`).

## How it works

```text
Jellyfin Web  →  /MediaWordFilter/ClientScript   (injected via File Transformation)
              →  /MediaWordFilter/mutes/{id}     (auth)  →  MWF GET /mutes/{id}
              →  /MediaWordFilter/profiles       (auth)  →  MWF GET /api/profiles
```

Mute application matches JMS: poll HTML5 `video.muted` on half-open intervals `[start_ms, end_ms)`. Item ids are Jellyfin **item `Id`** values only (never `MediaSourceId`).

Per-browser settings (localStorage):

| Key | Meaning |
|-----|---------|
| `mwfFilterEnabled` | Filter master switch (default on) |
| `mwfProfileUserId` | Optional MWF profile / user id override (empty = current Jellyfin user) |

## Manual test checklist

1. Process a movie in MWF so mute ranges exist for your Jellyfin user.
2. Plugin Dashboard **Test** succeeds.
3. Open that item’s details page → MWF panel appears under Audio → profiles load.
4. Play the item → audio mutes on known intervals (no extension installed).
5. OSD button → turn filter **off** → muting stops; **on** → resumes.
6. Play a TV episode that has a next episode with mute data → Network tab shows mute fetch for current and prefetch for next; starting the next episode uses cache quickly.
7. Confirm JMP / JMS still work independently.

## Limitations

- **Jellyfin Web only** — Android TV, Swiftfin, Infuse, JMP need their own clients.
- Cast / remote players without a local `<video>` element are not supported.
- Details/OSD DOM hooks can drift across jellyfin-web versions; soft-fail if selectors change.
- Official Jellyfin has no supported web UI injection API; File Transformation is required.

## Layout

```text
clients/jellyfin-plugin/
  README.md
  build.sh
  manifest.json                          # repository catalog for Jellyfin
  Jellyfin.Plugin.MediaWordFilter/
    meta.json                            # packed inside the release zip
    Plugin.cs
    PluginServiceRegistrator.cs
    Configuration/
    Controllers/
    Hosted/
    Services/
    Web/mwf-client.js
    Web/mwf-client.css
```
