#!/usr/bin/env bash
# Write gitignored secrets from .env into cursor-cp/.env (loaded at runtime).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/.env"
DEST="$ROOT/cursor-cp/.env"
EXAMPLE="$ROOT/.env.example"

if [ ! -f "$SRC" ]; then
  cp "$EXAMPLE" "$SRC"
  chmod 600 "$SRC"
  echo "Created $SRC"
  echo "Fill TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_USER_ID, CURSOR_API_KEY then re-run."
  echo "  Bot token:  https://t.me/BotFather  (/newbot)"
  echo "  User id:    https://t.me/userinfobot"
  echo "  Cursor key: https://cursor.com/dashboard/integrations"
  exit 1
fi

need() {
  local key="$1"
  local val
  val="$(grep -E "^${key}=" "$SRC" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]')"
  if [ -z "$val" ]; then
    echo "Missing $key in $SRC"
    return 1
  fi
}

missing=0
need TELEGRAM_BOT_TOKEN || missing=1
need TELEGRAM_ALLOWED_USER_ID || missing=1
need CURSOR_API_KEY || missing=1
if [ "$missing" -ne 0 ]; then
  echo "Fill the empty values in $SRC then re-run this script."
  exit 1
fi

cp "$SRC" "$DEST"
chmod 600 "$SRC" "$DEST"
echo "Wrote $DEST (chmod 600). Restart cursor-cp to pick up secrets."
