# Media Word Filter — Jellyfin server plugin

C# plugin for **Jellyfin 10.11.x**: Dashboard config and authenticated `/MediaWordFilter/…` proxy to your MWF service.

**1.0.7+ does not patch jellyfin-web.** Earlier builds registered File Transformation on `index.html`; a bad transform payload could return empty HTML and break details/player pages. Use JMP (`clients/jmp`) or the browser extension (`clients/jms`) for muting until a safe inject path exists.

## Requirements

1. **Jellyfin Server 10.11.x** (plugin targets `net9.0` / Jellyfin ABI 10.11; built against **10.11.4**)
2. A reachable **Media Word Filter** HTTP service (e.g. `http://mwf:8787` on Docker)
3. File Transformation is **not** required for 1.0.7+

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
5. Hard-refresh Jellyfin Web (`Ctrl+Shift+R`).

## How it works

```text
Dashboard / clients  →  /MediaWordFilter/mutes/{id}  (auth)  →  MWF GET /mutes/{id}
                     →  /MediaWordFilter/profiles    (auth)  →  MWF GET /api/profiles
                     →  /MediaWordFilter/health               →  MWF health
Embedded ClientScript/CSS endpoints remain for a future safe inject; they are not auto-loaded in 1.0.7+.
```

## Manual test checklist

1. Plugin Dashboard **Test** succeeds against your MWF base URL.
2. Authenticated `GET /MediaWordFilter/mutes/{itemId}` returns mute data.
3. Details page and player load normally (no blank UI).
4. Muting via JMP / JMS still works independently.

## Limitations

- **No jellyfin-web UI injection in 1.0.7+** — use JMP or JMS for mute until a safe File Transformation path is restored.
- Cast / remote players without a local `<video>` element are not supported by the JS mute clients.
- Official Jellyfin has no supported web UI injection API.

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
