#!/bin/bash
# End-to-end acceptance for the compiled binary. Run after `bun run build`.
# Exercises the paths that break under `bun build --compile`: the embedded web
# console, the job runner, self-re-exec, and the favicon route.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN=dist/bin/pgw
HOME_DIR="$PWD/dist/verify-home"
PORT=7397
TOKEN=""

cleanup() {
  pkill -f "dist/bin/pgw __serve" 2>/dev/null || true
  pkill -f "dist/bin/pgw" 2>/dev/null || true
}
trap cleanup EXIT

fail() { echo "  ✗ $1"; exit 1; }
pass() { echo "  ✓ $1"; }

echo "=== 1. artifact types ==="
for t in darwin-arm64 darwin-x64 linux-x64 linux-arm64; do
  printf "  %-14s " "$t"
  file "dist/bin/pgw-$t" | sed 's/.*: //' | cut -c1-62
done

echo "=== 2. host binary smoke ==="
cleanup; sleep 1
rm -rf "$HOME_DIR"; mkdir -p "$HOME_DIR"
PGW_HOME="$HOME_DIR" PGW_PORT=$PORT "$BIN" --version >/dev/null || fail "--version"
pass "--version"
PGW_HOME="$HOME_DIR" PGW_PORT=$PORT "$BIN" --help | grep -q "Personal Gateway" || fail "--help"
pass "--help"

echo "=== 3. server: embedded console ==="
PGW_HOME="$HOME_DIR" PGW_PORT=$PORT "$BIN" __serve >dist/verify.log 2>&1 &
for _ in $(seq 1 40); do sleep 0.5; curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; done
TOKEN=$(base64 < "$HOME_DIR/admin.key" | tr -d '\n' | tr '+/' '-_' | tr -d '=')
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$CODE" = 200 ] || fail "GET / returned $CODE"
pass "GET / → 200"

CHUNK=$(curl -s "http://127.0.0.1:$PORT/" | grep -o 'chunk-[a-z0-9]*\.js' | head -1)
curl -s -o /dev/null -w '' "http://127.0.0.1:$PORT/$CHUNK" || fail "js chunk"
pass "embedded JS chunk ($CHUNK)"

ICON=$(curl -s "http://127.0.0.1:$PORT/" | grep -o 'icon-[a-z0-9]*\.svg' | head -1)
ICODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/$ICON")
[ "$ICODE" = 200 ] || fail "favicon returned $ICODE (Bun does not route <link rel=icon>)"
pass "favicon → 200 ($ICON)"

echo "=== 4. job runner (Worker cannot work compiled) ==="
JOB=$(curl -s -X POST -H "authorization: Bearer $TOKEN" -H "content-type: application/json" \
  "http://127.0.0.1:$PORT/api/registry/scan" | sed -n 's/.*"job":{"id":"\([^"]*\)".*/\1/p')
[ -n "$JOB" ] || fail "job submission"
STATUS=""
for _ in $(seq 1 15); do
  sleep 1
  STATUS=$(curl -s -H "authorization: Bearer $TOKEN" "http://127.0.0.1:$PORT/api/jobs/$JOB" | sed -n 's/.*"status":"\([^"]*\)".*/\1/p')
  case "$STATUS" in completed|failed|uncertain|cancelled) break ;; esac
done
[ "$STATUS" = completed ] || fail "job ended as '$STATUS' (worker_stopped means the runner did not spawn)"
pass "job completed"

echo "=== 5. diagnostics ==="
PGW_HOME="$HOME_DIR" PGW_PORT=$PORT "$BIN" doctor >/dev/null || fail "doctor"
pass "doctor"

echo "=== 6. self re-exec (detached server) ==="
cleanup; sleep 2
PGW_HOME="$HOME_DIR" PGW_PORT=$PORT "$BIN" scan >/dev/null || fail "scan could not start a detached server"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$CODE" = 200 ] || fail "detached server did not come up"
pass "pgw scan spawned its own server"

echo "=== 7. source mode still works ==="
cleanup; sleep 1
rm -rf dist/verify-src; mkdir -p dist/verify-src
PGW_HOME="$PWD/dist/verify-src" PGW_PORT=$PORT bun src/cli.ts __serve >dist/verify-src.log 2>&1 &
for _ in $(seq 1 40); do sleep 0.5; curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; done
CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")
[ "$CODE" = 200 ] || fail "source mode server returned $CODE"
pass "source mode __serve → 200"

echo
echo "all checks passed"
