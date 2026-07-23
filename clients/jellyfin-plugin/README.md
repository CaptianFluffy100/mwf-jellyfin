# Media Word Filter — Jellyfin server plugin

C# plugin for **Jellyfin 10.11.x**: Dashboard config, authenticated `/MediaWordFilter/…` proxy to your MWF service, and details-page UI in Jellyfin Web (profile + filter toggle under Audio).

**1.0.8** restores safe File Transformation inject for the details-page UI. Playback OSD / media-bar injection remains disabled.

## Requirements

1. **Jellyfin Server 10.11.x** (plugin targets `net9.0` / Jellyfin ABI 10.11; built against **10.11.4**)
2. A reachable **Media Word Filter** HTTP service (e.g. `http://mwf:8787` on Docker)
3. **[File Transformation](https://www.iamparadox.dev/jellyfin/plugins/manifest.json)** plugin (required for jellyfin-web client script inject)

## Packaging files Jellyfin expects

| File | Role |
|------|------|
| [`manifest.json`](manifest.json) | **Plugin repository catalog** — add this URL under Dashboard → Plugins → Repositories |
| [`Jellyfin.Plugin.MediaWordFilter/meta.json`](Jellyfin.Plugin.MediaWordFilter/meta.json) | Packed **inside** the release zip next to the DLL |

`versions[].sourceUrl` in `manifest.json` must point at a hosted zip; `checksum` is the **MD5** of that zip (filled by `build.sh`).

## Build

From this directory (uses the official .NET 9 SDK container — no host SDK required):

```bash
chmod +x build.sh
./build.sh
```

Produces:

- `dist/jellyfin-plugin-mediawordfilter_1.0.8.0.zip` (DLL + `meta.json`)
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
4. Catalog → install **Media Word Filter** (1.0.8+).

### Manual (DLL / zip)

1. Unzip `dist/jellyfin-plugin-mediawordfilter_*.zip` into a plugin folder, e.g.:
   - Docker: `/config/plugins/MediaWordFilter/`
   - Linux: `/var/lib/jellyfin/plugins/MediaWordFilter/`
   (folder must contain `Jellyfin.Plugin.MediaWordFilter.dll` and `meta.json`)
2. Restart Jellyfin.

### Configure

4. Dashboard → **Plugins** → **Media Word Filter**:
   - Set **MWF base URL** (e.g. `http://192.168.1.10:8787` or Docker service name)
   - Click **Test MWF connection**
   - Save
5. Confirm **File Transformation** is installed and enabled.
6. Hard-refresh Jellyfin Web (`Ctrl+Shift+R`).

## How it works

```text
File Transformation  →  index.html  →  <script src="/MediaWordFilter/ClientScript">
Dashboard / clients  →  /MediaWordFilter/mutes/{id}  (auth)  →  MWF GET /mutes/{id}
                     →  /MediaWordFilter/profiles    (auth)  →  MWF GET /api/profiles
                     →  /MediaWordFilter/health               →  MWF health
```

Details page: profile selector + filter on/off under Audio. Mute loop runs during playback. No playback OSD / media-bar DOM injection.

## Manual test checklist

1. Plugin Dashboard **Test** succeeds against your MWF base URL.
2. Jellyfin log shows: `Registered Media Word Filter index.html transformation with File Transformation`.
3. Item details page shows **Media Word Filter** panel under Audio.
4. Details page and player load normally (no blank UI).
5. Filter toggles and mute ranges apply during playback.

## Limitations

- **No playback OSD / media-bar UI** — controls stay on the details page only (OSD inject removed in 1.0.4–1.0.5).
- Cast / remote players without a local `<video>` element are not supported by the JS mute clients.
- Official Jellyfin has no supported web UI injection API; File Transformation is a community plugin.

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
