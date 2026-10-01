#!/usr/bin/env bash
# Install or upgrade ica-hub as a bare-systemd service on Debian 13.
#
# Usage: run as root from a copy of the source tree at /opt/ica-hub (see
# docs/deployment.md for the rsync command that gets it there):
#
#   ICA_HUB_URL=https://ica.example.com deploy/install.sh
#
# Idempotent: safe to re-run after re-syncing the source for an upgrade. Never
# overwrites an existing /etc/ica-hub/env — edit that file by hand to change
# settings or rotate secrets.
set -euo pipefail

APP_DIR=/opt/ica-hub
DATA_DIR=/var/lib/ica-hub
CONFIG_DIR=/etc/ica-hub
ENV_FILE="$CONFIG_DIR/env"
SERVICE_USER=ica-hub
SERVICE_NAME=ica-hub
PORT="${PORT:-3000}"

if [[ "$EUID" -ne 0 ]]; then
  echo "error: must run as root" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "error: $APP_DIR/package.json not found — sync the source tree to $APP_DIR first" >&2
  exit 1
fi

echo "==> installing apt dependencies"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates curl build-essential python3

echo "==> checking Node.js"
node_major=0
if command -v node >/dev/null 2>&1; then
  node_major="$(node --version | sed -E 's/^v([0-9]+).*/\1/')"
fi
if [[ "$node_major" -lt 24 ]]; then
  echo "    installing Node.js 24.x via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
node_version="$(node --version)"
if [[ "$node_version" != v24* ]]; then
  echo "error: expected Node.js v24.x after install, got $node_version" >&2
  exit 1
fi
echo "    node $node_version"

echo "==> enabling corepack"
corepack enable

echo "==> creating service user/group and directories"
if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --home-dir "$DATA_DIR" --shell /usr/sbin/nologin --user-group "$SERVICE_USER"
  echo "    created system user/group $SERVICE_USER"
else
  echo "    user $SERVICE_USER already exists"
fi
install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR"
install -d -m 0750 -o root -g "$SERVICE_USER" "$CONFIG_DIR"

echo "==> building ica-hub in $APP_DIR"
chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
runuser -u "$SERVICE_USER" -- bash -c "
  set -euo pipefail
  cd '$APP_DIR'
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
  pnpm install --frozen-lockfile
  pnpm build
  pnpm prune --prod
"

echo "==> writing $ENV_FILE"
if [[ -f "$ENV_FILE" ]]; then
  echo "    $ENV_FILE already exists — leaving it untouched"
else
  master_key="$(openssl rand -base64 32)"
  auth_secret="$(openssl rand -base64 32)"
  generated_keys=(ICA_HUB_MASTER_KEY ICA_HUB_AUTH_SECRET)
  url_value="${ICA_HUB_URL:-CHANGE_ME_SET_ICA_HUB_URL}"
  {
    echo "ICA_HUB_URL=$url_value"
    echo "ICA_HUB_MASTER_KEY=$master_key"
    echo "ICA_HUB_AUTH_SECRET=$auth_secret"
    echo "DATABASE_PATH=$DATA_DIR/ica-hub.db"
    echo "TRUST_PROXY=1"
    echo "PORT=$PORT"
    echo "HOST=0.0.0.0"
    echo "NODE_ENV=production"
    if [[ -n "${ICA_HUB_ADMIN_EMAIL:-}" && -n "${ICA_HUB_ADMIN_PASSWORD:-}" ]]; then
      echo "ICA_HUB_ADMIN_EMAIL=$ICA_HUB_ADMIN_EMAIL"
      echo "ICA_HUB_ADMIN_PASSWORD=$ICA_HUB_ADMIN_PASSWORD"
      generated_keys+=(ICA_HUB_ADMIN_EMAIL ICA_HUB_ADMIN_PASSWORD)
    fi
  } > "$ENV_FILE"
  chmod 0640 "$ENV_FILE"
  chown root:"$SERVICE_USER" "$ENV_FILE"
  echo "    created $ENV_FILE"
  echo "    generated values for: ${generated_keys[*]} (values not printed)"
  if [[ -z "${ICA_HUB_URL:-}" ]]; then
    echo "    warning: ICA_HUB_URL was not set — wrote a placeholder that makes the service fail fast until you set the real public origin in $ENV_FILE"
  fi
fi

echo "==> installing systemd unit"
install -m 0644 "$APP_DIR/deploy/ica-hub.service" /etc/systemd/system/ica-hub.service
systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"
# restart (not just enable --now) so an upgrade's new build takes effect even
# when the service was already running before this install
systemctl restart "$SERVICE_NAME"

echo "==> waiting for $SERVICE_NAME to become healthy"
ok=0
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 1
done

if [[ "$ok" -eq 1 ]]; then
  echo "==> healthy: $(curl -fsS "http://127.0.0.1:${PORT}/healthz")"
  exit 0
else
  echo "error: $SERVICE_NAME did not become healthy within 20s" >&2
  echo "---- last 30 journal lines ----" >&2
  journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2
  exit 1
fi
