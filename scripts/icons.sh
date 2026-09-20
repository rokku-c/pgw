#!/bin/bash
# Generates the Tauri icon set from source.png using macOS built-ins
# (sips for raster sizes, iconutil for .icns). No .ico — we only ship
# macOS and Linux, and Windows icons are the only consumer of that format.
set -euo pipefail
cd "$(dirname "$0")/../src-tauri/icons"

rm -rf icon.iconset
mkdir icon.iconset

render() { # size filename
  sips -z "$1" "$1" source.png --out "$2" >/dev/null
}

render 16   icon.iconset/icon_16x16.png
render 32   icon.iconset/icon_16x16@2x.png
render 32   icon.iconset/icon_32x32.png
render 64   icon.iconset/icon_32x32@2x.png
render 128  icon.iconset/icon_128x128.png
render 256  icon.iconset/icon_128x128@2x.png
render 256  icon.iconset/icon_256x256.png
render 512  icon.iconset/icon_256x256@2x.png
render 512  icon.iconset/icon_512x512.png
render 1024 icon.iconset/icon_512x512@2x.png

iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset

render 32  32x32.png
render 128 128x128.png
render 256 128x128@2x.png
render 512 icon.png

echo "icon set:"
ls -1
