#!/usr/bin/env bash
# Pulls the latest IXG Wall from git and restarts it. On the server:
#   sudo bash /opt/ixg-wall/deploy/update.sh
# Open walls keep the old page until reloaded: reload them after an update.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE=/etc/ixg-wall/ixg-wall.env

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo bash $0" >&2; exit 1; }

before="$(git -C "$APP_DIR" rev-parse --short HEAD)"
git -C "$APP_DIR" pull --ff-only
after="$(git -C "$APP_DIR" rev-parse --short HEAD)"

if [[ "$before" == "$after" ]]; then
  echo "Already up to date ($after)."
elif ! git -C "$APP_DIR" diff --quiet "$before" "$after" -- deploy/; then
  # A changed service file or Caddy site only applies when setup runs again.
  echo "deploy/ changed: also run  sudo bash $APP_DIR/deploy/setup.sh --url <address> [--cdn]"
fi

systemctl restart ixg-wall
PORT="$(grep -E '^PORT=' "$ENV_FILE" 2>/dev/null | cut -d= -f2 || true)"
PORT="${PORT:-8080}"
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo "Running $after. Reload any open walls to get the new version."
    exit 0
  fi
  sleep 1
done
echo "Restarted, but the wall isn't answering. Logs: journalctl -u ixg-wall -n 50" >&2
exit 1
