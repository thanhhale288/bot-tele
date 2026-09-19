#!/usr/bin/env bash
# Start a Cloudflare quick tunnel to the local dashboard and print the URL.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${1:-8747}"
BIN="${CLOUDFLARED_BIN:-$ROOT/bin/cloudflared}"
if [ ! -x "$BIN" ]; then
  echo "cloudflared binary missing at $BIN" >&2
  echo "Re-run the install step that downloads GitHub cloudflared releases." >&2
  exit 1
fi
exec "$BIN" tunnel --url "http://127.0.0.1:${PORT}" --no-autoupdate
