#!/bin/bash
# Launches the built desktop shell against a throwaway PGW_HOME/PGW_PORT so it
# cannot touch a real gateway's data.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="src-tauri/target/release/bundle/macos/Personal Gateway.app/Contents/MacOS/personal-gateway"
[ -x "$APP" ] || { echo "app not built: $APP"; exit 1; }

rm -rf dist/app-test
mkdir -p dist/app-test
export PGW_HOME="$PWD/dist/app-test"
export PGW_PORT=7398

echo "HOME=$PGW_HOME PORT=$PGW_PORT"
exec "$APP"
