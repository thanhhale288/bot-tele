#!/usr/bin/env bash
# Keep this Mac from sleeping so cursor-cp / Telegram stay reachable.
#   ./scripts/keep-awake.sh            # foreground caffeinate (Ctrl+C to stop)
#   ./scripts/keep-awake.sh --install  # LaunchAgent (survives closing Terminal)
#   ./scripts/keep-awake.sh --remove
set -euo pipefail

LABEL="com.cursor.cp.caffeinate"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"

usage() {
  cat <<'EOF'
Usage: ./scripts/keep-awake.sh [--install|--remove]

  (no args)   Run caffeinate -dims in the foreground
  --install   Install a LaunchAgent that keeps the Mac awake
  --remove    Unload and delete that LaunchAgent

Lid-close sleep is separate: see ./scripts/disable-lid-sleep.sh
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${1:-}" == "--remove" ]]; then
  UID_NUM="$(id -u)"
  launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
  rm -f "$PLIST"
  echo "Removed $LABEL"
  exit 0
fi

if [[ "${1:-}" == "--install" ]]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
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
  launchctl bootout "gui/${UID_NUM}/${LABEL}" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/${UID_NUM}" "$PLIST"
  echo "Installed $PLIST (caffeinate -dims)."
  echo "Lid-close sleep is unchanged. See ./scripts/disable-lid-sleep.sh"
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  usage
  exit 1
fi

echo "Running caffeinate -dims (Ctrl+C to allow sleep again)."
exec /usr/bin/caffeinate -dims
