#!/bin/bash
# Simulates an installed @rokku-c/pgw tree and exercises the shim, since the
# platform packages are not on any registry yet.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist/shimtest
mkdir -p dist/shimtest/node_modules/@rokku-c
cp -R dist/npm/pgw dist/shimtest/node_modules/@rokku-c/pgw
cp -R dist/npm/pgw-darwin-arm64 dist/shimtest/node_modules/@rokku-c/pgw-darwin-arm64
SHIM=dist/shimtest/node_modules/@rokku-c/pgw/bin/pgw.js

echo "--- 1. shim resolves + runs the real binary (--version) ---"
node "$SHIM" --version

echo "--- 2. exit code passthrough (unknown command should be 1) ---"
set +e
node "$SHIM" bogus >/dev/null 2>&1
echo "exit=$?"
set -e

echo "--- 3. stdio passthrough (--help must reach stdout) ---"
node "$SHIM" --help | head -2

echo "--- 4. missing platform package gives a useful error ---"
rm -rf dist/shimtest/node_modules/@rokku-c/pgw-darwin-arm64
set +e
node "$SHIM" --version 2>&1 | head -3
echo "exit=${PIPESTATUS[0]}"
set -e
