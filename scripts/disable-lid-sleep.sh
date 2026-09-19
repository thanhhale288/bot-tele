#!/usr/bin/env bash
# Show or apply macOS pmset flags so the Mac can stay up with the lid closed.
# Default is preview-only. --apply requires sudo and changes system sleep.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./scripts/disable-lid-sleep.sh [--apply|--restore]

  (no args)   Print current pmset sleep settings and the commands that would run
  --apply     sudo pmset: sleep 0, disablesleep 1, lidwake 0
  --restore   sudo pmset restore defaults for those keys (sleep 1, lidwake 1)

Only do this on a machine you own and understand. Heat + closed lid is your risk.
Prefer ./scripts/keep-awake.sh (caffeinate) when the lid stays open.
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

echo "Current pmset:"
pmset -g | sed -n '1,20p' || true
echo

if [[ "${1:-}" == "--apply" ]]; then
  sudo pmset -a sleep 0 disablesleep 1 lidwake 0
  echo "Applied: sleep 0, disablesleep 1, lidwake 0"
  exit 0
fi

if [[ "${1:-}" == "--restore" ]]; then
  sudo pmset -a sleep 1 disablesleep 0 lidwake 1
  echo "Restored: sleep 1, disablesleep 0, lidwake 1"
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  usage
  exit 1
fi

echo "Preview (not applied). To apply:"
echo "  sudo pmset -a sleep 0 disablesleep 1 lidwake 0"
echo "To restore:"
echo "  sudo pmset -a sleep 1 disablesleep 0 lidwake 1"
echo
echo "Or: $0 --apply   /   $0 --restore"
