#!/usr/bin/env bash
# Sets up IXG Wall on an Ubuntu 22.04/24.04 server (AWS Lightsail or EC2), from this checkout:
#   sudo bash deploy/setup.sh --url https://wall.example.com          own (sub)domain; Caddy does HTTPS
#   sudo bash deploy/setup.sh --url https://d111abc.cloudfront.net --cdn   behind CloudFront / Lightsail CDN
# Installs Node 22 and Caddy, runs the wall as a systemd service, and prints the password.
# Safe to run again: it keeps the password and settings in /etc/ixg-wall/ixg-wall.env.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_DIR=/etc/ixg-wall
ENV_FILE=$ENV_DIR/ixg-wall.env
DATA_DIR=/var/lib/ixg-wall
SERVICE=ixg-wall
SERVICE_USER=ixgwall
URL=""
CDN=0

usage() {
  sed -n '2,6p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --url) URL="${2:-}"; shift 2 ;;
    --cdn) CDN=1; shift ;;
    -h|--help) usage ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }
die() { echo "Error: $*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: sudo bash $0 --url https://..."
[[ "$URL" =~ ^https://[A-Za-z0-9.-]+$ ]] || die "--url must be the https address people will open, with no path, e.g. https://wall.example.com"
command -v apt-get >/dev/null || die "this script expects Ubuntu or Debian (apt-get)"
case "$APP_DIR" in
  /home/*|/root/*) die "put the project outside home folders (e.g. sudo git clone ... /opt/ixg-wall): the service isn't allowed to read /home" ;;
esac
DOMAIN="${URL#https://}"

step "Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git openssl debian-keyring debian-archive-keyring apt-transport-https >/dev/null

NODE_MAJOR="$( (node -v 2>/dev/null || echo v0) | sed -E 's/^v([0-9]+).*/\1/')"
if (( NODE_MAJOR < 22 )); then
  step "Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
echo "node $(node -v) at $NODE_BIN"

if ! command -v caddy >/dev/null; then
  step "Caddy (HTTPS and reverse proxy)"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi
caddy version | head -n 1

step "Service user and folders"
id -u "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"
install -d -m 750 -o root -g "$SERVICE_USER" "$ENV_DIR"
install -d -m 750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
sudo -u "$SERVICE_USER" test -r "$APP_DIR/server.js" || die "the service user can't read $APP_DIR/server.js; check the folder's permissions"

step "Settings ($ENV_FILE)"
NEW_PASSWORD=""
if [[ ! -f "$ENV_FILE" ]]; then
  NEW_PASSWORD="$(openssl rand -hex 12)"
  install -m 640 -o root -g "$SERVICE_USER" /dev/null "$ENV_FILE"
  cat >> "$ENV_FILE" <<EOF
# IXG Wall settings. After editing: sudo systemctl restart ixg-wall
# Run as a website: sign-in required; no wall window or laptop telemetry.
IXG_HOSTED=1
# The address people open.
PUBLIC_URL=$URL
# Shared sign-in password (12+ characters). Changing it signs everyone out.
IXG_PASSWORD=$NEW_PASSWORD
# Optional: the YouTube Data API key, set here instead of in the wall's Settings.
YOUTUBE_API_KEY=
# Optional: Google OAuth client for the channel sign-in (ingest health), instead of Settings.
# Its authorised redirect URI must be $URL/api/youtube/oauth/callback
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
IXG_DATA_DIR=$DATA_DIR
HOST=127.0.0.1
PORT=8080
EOF
  echo "Created, with a new password (shown at the end)."
else
  sed -i -E "s#^PUBLIC_URL=.*#PUBLIC_URL=$URL#" "$ENV_FILE"
  echo "Kept the existing settings and password; PUBLIC_URL is $URL."
fi
PORT="$(grep -E '^PORT=' "$ENV_FILE" | cut -d= -f2 || true)"
PORT="${PORT:-8080}"

step "Wall service"
sed -e "s#__APP_DIR__#$APP_DIR#g" -e "s#__ENV_FILE__#$ENV_FILE#g" -e "s#__USER__#$SERVICE_USER#g" \
  -e "s#__DATA_DIR__#$DATA_DIR#g" -e "s#__NODE__#$NODE_BIN#g" \
  "$APP_DIR/deploy/ixg-wall.service" > "/etc/systemd/system/$SERVICE.service"
systemctl daemon-reload
systemctl enable --quiet "$SERVICE"
systemctl restart "$SERVICE"

step "Caddy site"
TOKEN=""
TEMPLATE=domain.Caddyfile
if (( CDN )); then
  TOKEN_FILE=$ENV_DIR/origin-token
  [[ -s "$TOKEN_FILE" ]] || { openssl rand -hex 24 > "$TOKEN_FILE"; chmod 600 "$TOKEN_FILE"; }
  TOKEN="$(cat "$TOKEN_FILE")"
  TEMPLATE=cdn.Caddyfile
fi
if [[ -f /etc/caddy/Caddyfile && ! -f /etc/caddy/Caddyfile.before-ixg-wall ]]; then
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-ixg-wall
fi
sed -e "s#__DOMAIN__#$DOMAIN#g" -e "s#__PORT__#$PORT#g" -e "s#__ORIGIN_TOKEN__#$TOKEN#g" \
  "$APP_DIR/deploy/caddy/$TEMPLATE" > /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable --quiet caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

step "Check"
up=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then up=1; break; fi
  sleep 1
done
(( up )) || die "the wall didn't answer on port $PORT. Logs: journalctl -u $SERVICE -n 50"
echo "The wall is running."
PUBLIC_IP="$(curl -fsS --max-time 5 https://checkip.amazonaws.com 2>/dev/null || echo unknown)"

cat <<EOF

IXG Wall is installed.
  Address:    $URL
  Password:   ${NEW_PASSWORD:-unchanged (IXG_PASSWORD in $ENV_FILE)}
  Server IP:  $PUBLIC_IP
  Settings:   $ENV_FILE
  Data:       $DATA_DIR
  Logs:       journalctl -u $SERVICE -f

Next:
EOF
if (( CDN )); then
  cat <<EOF
  - In CloudFront, give the origin a custom header (DEPLOY.md, step 4b):
      X-Origin-Verify: $TOKEN
  - Allow port 80 in the server's firewall; 443 isn't needed (the CDN does HTTPS).
EOF
else
  cat <<EOF
  - DNS: add an A record  $DOMAIN -> $PUBLIC_IP
    Caddy fetches the HTTPS certificate once that resolves; ports 80 and 443 must be open.
EOF
fi
cat <<EOF
  - YouTube key: in Google Cloud, restrict it to the IP $PUBLIC_IP, then paste it in
    Settings -> YouTube API on the wall (or set YOUTUBE_API_KEY in $ENV_FILE).
  - Updates later: sudo bash $APP_DIR/deploy/update.sh
EOF
