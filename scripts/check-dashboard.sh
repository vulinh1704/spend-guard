#!/usr/bin/env bash
# Runs the mock demo with its dashboard, checks the page with Mantis (mobile + desktop, light +
# dark), then stops the demo. Run before recording a video.
#   scripts/check-dashboard.sh [mantis-dir]   (default ~/projects/mantis)
set -euo pipefail
cd "$(dirname "$0")/.."
mantis="${1:-$HOME/projects/mantis}/bin/mantis.js"
port="${DASHBOARD_PORT:-4400}"
log="$(mktemp)"

DASHBOARD_PORT="$port" node demo/agent.js --dashboard > "$log" 2>&1 &
demo=$!
trap 'kill "$demo" 2>/dev/null || true; rm -f "$log"' EXIT

until grep -q "stays up" "$log"; do
  kill -0 "$demo" 2>/dev/null || { cat "$log"; exit 1; }
  sleep 1
done
node "$mantis" look "http://localhost:$port/" --viewports mobile,desktop --schemes light,dark --out .mantis --timeout 45000
