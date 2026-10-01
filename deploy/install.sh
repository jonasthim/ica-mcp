#!/usr/bin/env bash
# Install or upgrade ica-hub as a bare-systemd service on Debian 13 (e.g. an LXC).
#
# Two ways to get the source, then the same build and service setup:
#
# 1. From a GitHub release (the default for a fresh host). Run as root:
#
#      curl -fsSL https://github.com/jonasthim/ica-mcp/releases/latest/download/install.sh \
#        | ICA_HUB_URL=https://ica.example.com bash
#
#    The script downloads ica-mcp-<version>.tar.gz and SHA256SUMS from the release, verifies the checksum, and
#    replaces the source in /opt/ica-hub with it. Re-run it with no arguments to upgrade to the latest release.
#
# 2. From a source tree already at /opt/ica-hub (rsync; see docs/deployment.md). Run as root from there:
#
#      ICA_HUB_URL=https://ica.example.com deploy/install.sh
#
# The release path is used when ICA_HUB_VERSION is set, when /opt/ica-hub has no package.json yet, or when
# /opt/ica-hub was installed from a release before (it has a VERSION file; rsync --delete removes that file).
# Otherwise the existing source tree is built as it is.
#
# Environment:
#   ICA_HUB_URL       public https origin, written into /etc/ica-hub/env on the first install only
#   ICA_HUB_VERSION   release to install, e.g. 0.2.0 (default: the latest release)
#   ICA_HUB_REPO      GitHub owner/repo to download from (default: jonasthim/ica-mcp), or a base URL that serves
#                     the same releases/download/v<version>/ layout (a mirror)
#   PORT              listen port written into a new env file (default 3000)
#
# Idempotent: safe to re-run. Never overwrites an existing /etc/ica-hub/env: edit that file by hand to change
# settings or rotate secrets. Never reads from stdin, so it works when piped into bash.
set -euo pipefail

APP_DIR=/opt/ica-hub
DATA_DIR=/var/lib/ica-hub
CONFIG_DIR=/etc/ica-hub
ENV_FILE="$CONFIG_DIR/env"
SERVICE_USER=ica-hub
SERVICE_NAME=ica-hub
PORT="${PORT:-3000}"
ICA_HUB_REPO="${ICA_HUB_REPO:-jonasthim/ica-mcp}"

WORK_DIR=""
cleanup() {
  if [[ -n "$WORK_DIR" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

die() {
  echo "error: $*" >&2
  exit 1
}

# Base URL of the repository: https://github.com/<owner>/<repo>, or ICA_HUB_REPO itself if it is a URL.
repo_base_url() {
  if [[ "$ICA_HUB_REPO" == http://* || "$ICA_HUB_REPO" == https://* ]]; then
    echo "${ICA_HUB_REPO%/}"
  else
    echo "https://github.com/$ICA_HUB_REPO"
  fi
}

valid_version() {
  [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]]
}

# Prints the version to install: ICA_HUB_VERSION (a leading "v" is accepted), or the latest release, read from
# where GitHub's releases/latest redirect lands (.../releases/tag/v<version>). No API call, so no API rate limit.
resolve_version() {
  local version effective
  if [[ -n "${ICA_HUB_VERSION:-}" ]]; then
    version="${ICA_HUB_VERSION#v}"
  else
    effective="$(curl -fsSIL --retry 3 -o /dev/null -w '%{url_effective}' "$(repo_base_url)/releases/latest")" \
      || die "could not reach $(repo_base_url)/releases/latest"
    if [[ "$effective" != */releases/tag/v* ]]; then
      die "no published release found at $(repo_base_url) (releases/latest went to $effective)"
    fi
    version="${effective##*/releases/tag/v}"
  fi
  valid_version "$version" || die "not a release version: '$version'"
  echo "$version"
}

# fetch_release <version> <work dir>: downloads ica-mcp-<version>.tar.gz and SHA256SUMS into the work dir,
# verifies the tarball against SHA256SUMS, extracts it, and prints the extracted source directory.
# Aborts (without extracting anything) on a download failure, a missing checksum line or a mismatch.
fetch_release() {
  local version="$1" dir="$2"
  local tarball="ica-mcp-${version}.tar.gz"
  local url
  url="$(repo_base_url)/releases/download/v${version}"

  curl -fsSL --retry 3 -o "$dir/$tarball" "$url/$tarball" || die "download failed: $url/$tarball"
  curl -fsSL --retry 3 -o "$dir/SHA256SUMS" "$url/SHA256SUMS" || die "download failed: $url/SHA256SUMS"

  local expected actual
  expected="$(awk -v f="$tarball" '$2 == f || $2 == "*" f { print $1; exit }' "$dir/SHA256SUMS")"
  [[ -n "$expected" ]] || die "SHA256SUMS has no entry for $tarball"
  actual="$(sha256sum "$dir/$tarball" | awk '{ print $1 }')"
  if [[ "$actual" != "$expected" ]]; then
    die "checksum mismatch for $tarball (expected $expected, got $actual): not installing"
  fi
  echo "    checksum ok: $tarball" >&2

  mkdir -p "$dir/src"
  tar -xzf "$dir/$tarball" -C "$dir/src"
  local src="$dir/src/ica-mcp-${version}"
  [[ -f "$src/package.json" ]] || die "$tarball does not contain ica-mcp-${version}/package.json"
  echo "$src"
}

# install_tree <source dir> <version>: makes APP_DIR an exact copy of the release source. Everything in APP_DIR
# except node_modules (a cache that pnpm reconciles) is removed first; nothing stateful lives there (the database
# is in DATA_DIR, the config in ENV_FILE).
install_tree() {
  local src="$1" version="$2"
  install -d -m 0755 "$APP_DIR"
  find "$APP_DIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
  cp -a "$src/." "$APP_DIR/"
  echo "$version" > "$APP_DIR/VERSION"
}

use_release() {
  [[ -n "${ICA_HUB_VERSION:-}" || ! -f "$APP_DIR/package.json" || -f "$APP_DIR/VERSION" ]]
}

main() {
  if [[ "$EUID" -ne 0 ]]; then
    die "must run as root"
  fi

  echo "==> installing apt dependencies"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends ca-certificates curl openssl build-essential python3

  local installed_version
  if use_release; then
    local version src
    version="$(resolve_version)"
    echo "==> installing ica-mcp $version from $(repo_base_url)"
    WORK_DIR="$(mktemp -d)"
    src="$(fetch_release "$version" "$WORK_DIR")"
    install_tree "$src" "$version"
    installed_version="$version"
  else
    echo "==> using the source tree already in $APP_DIR"
    # A source install is not a release: drop a VERSION file left by an earlier release install.
    rm -f "$APP_DIR/VERSION"
    installed_version="$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' "$APP_DIR/package.json" | head -n1) (source)"
  fi

  echo "==> checking Node.js"
  local node_major=0 node_version
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
    die "expected Node.js v24.x after install, got $node_version"
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
    local master_key auth_secret url_value
    local -a generated_keys
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
  local ok=0
  for _ in $(seq 1 20); do
    if curl -fsS "http://127.0.0.1:${PORT}/healthz" >/dev/null 2>&1; then
      ok=1
      break
    fi
    sleep 1
  done

  if [[ "$ok" -eq 1 ]]; then
    echo "==> healthy: $(curl -fsS "http://127.0.0.1:${PORT}/healthz")"
    echo "==> installed ica-mcp $installed_version"
    exit 0
  else
    echo "error: $SERVICE_NAME did not become healthy within 20s" >&2
    echo "---- last 30 journal lines ----" >&2
    journalctl -u "$SERVICE_NAME" -n 30 --no-pager >&2
    exit 1
  fi
}

# Everything above only defines functions, so a truncated download (curl | bash) runs nothing. Tests can source the
# script with ICA_HUB_INSTALL_NO_MAIN=1 to call the functions on their own.
# stdin is /dev/null for the whole run: when piped, it is the script itself, and no command may read from it.
if [[ "${ICA_HUB_INSTALL_NO_MAIN:-}" != 1 ]]; then
  main "$@" </dev/null
fi
