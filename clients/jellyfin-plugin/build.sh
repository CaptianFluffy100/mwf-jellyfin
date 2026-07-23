#!/usr/bin/env bash
# Build Jellyfin.Plugin.MediaWordFilter release zip + refresh manifest checksum.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PROJ="$ROOT/Jellyfin.Plugin.MediaWordFilter"
OUT="$ROOT/dist"
VERSION="${PLUGIN_VERSION:-1.0.9.0}"
ZIP_NAME="jellyfin-plugin-mediawordfilter_${VERSION}.zip"
STAGE="$OUT/stage"
BUILD="$OUT/build"

mkdir -p "$BUILD"
rm -rf "$STAGE"
mkdir -p "$STAGE"

docker run --rm \
  -v "$PROJ:/src" \
  -v "$BUILD:/out" \
  -w /src \
  mcr.microsoft.com/dotnet/sdk:9.0 \
  bash -c 'dotnet restore && dotnet build -c Release && cp bin/Release/net9.0/Jellyfin.Plugin.MediaWordFilter.dll /out/ && cp bin/Release/net9.0/Jellyfin.Plugin.MediaWordFilter.pdb /out/ 2>/dev/null || true'

cp "$BUILD/Jellyfin.Plugin.MediaWordFilter.dll" "$STAGE/"
cp "$PROJ/meta.json" "$STAGE/meta.json"

rm -f "$OUT/$ZIP_NAME"
(
  cd "$STAGE"
  if command -v zip >/dev/null 2>&1; then
    zip -q -9 "$OUT/$ZIP_NAME" Jellyfin.Plugin.MediaWordFilter.dll meta.json
  else
    python3 -c "
import zipfile
z = zipfile.ZipFile(r'''$OUT/$ZIP_NAME''', 'w', zipfile.ZIP_DEFLATED)
z.write('Jellyfin.Plugin.MediaWordFilter.dll')
z.write('meta.json')
z.close()
"
  fi
)

CHECKSUM="$(python3 -c "import hashlib; print(hashlib.md5(open(r'''$OUT/$ZIP_NAME''','rb').read()).hexdigest())")"

python3 - <<PY
import json
from pathlib import Path
manifest_path = Path(r'''$ROOT''') / "manifest.json"
plugins = json.loads(manifest_path.read_text())
if not isinstance(plugins, list):
    plugins = [plugins]
plugin = plugins[0]
plugin.setdefault("versions", [{}])
v = plugin["versions"][0]
v["version"] = "$VERSION"
v["checksum"] = "$CHECKSUM"
v["targetAbi"] = v.get("targetAbi") or "10.11.0.0"
manifest_path.write_text(json.dumps(plugins, indent=2) + "\n")
print("checksum", "$CHECKSUM")
print("zip", r'''$OUT/$ZIP_NAME''')
PY

echo "Built:"
ls -la "$OUT/$ZIP_NAME" "$ROOT/manifest.json"
echo "Host the zip, set versions[0].sourceUrl in manifest.json to that URL, then add the manifest URL in Jellyfin → Dashboard → Plugins → Repositories."
