#!/usr/bin/env bash
# Enable launchd keep-alive for cursor-cp and a caffeinate job so the Mac stays awake.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CP="$ROOT/cursor-cp"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
CAFFEINATE_PLIST="$LAUNCH_AGENTS/com.cursor.cp.caffeinate.plist"
NODE="$(command -v node)"

if [ ! -f "$CP/dist/cli/index.js" ]; then
  echo "Build cursor-cp first: cd cursor-cp && npm ci && npm run build"
  exit 1
fi

mkdir -p "$HOME/cursor-cp/logs" "$LAUNCH_AGENTS"

export CURSOR_CP_INSTALL_DIR="$CP"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
"$NODE" "$CP/dist/cli/index.js" daemon enable

cat > "$CAFFEINATE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.cursor.cp.caffeinate</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/caffeinate</string>
        <string>-dims</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

UID_NUM="$(id -u)"
launchctl bootout "gui/${UID_NUM}/com.cursor.cp.caffeinate" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${UID_NUM}" "$CAFFEINATE_PLIST"
launchctl enable "gui/${UID_NUM}/com.cursor.cp.caffeinate" >/dev/null 2>&1 || true

echo "cursor-cp daemon + caffeinate LaunchAgents enabled."
echo "Dashboard: http://127.0.0.1:8747"
echo "From Telegram send /ui to get a public HTTPS URL."
