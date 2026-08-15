#!/usr/bin/env bash
set -euo pipefail

PI_WEB_VERSION="1.202608.1"
PI_WEB_SPEC="@jmfederico/pi-web@$PI_WEB_VERSION"
PI_WEB_HOST="127.0.0.1"
PI_WEB_PORT="8504"
CONFIG_FILE="${PI_WEB_CONFIG:-${XDG_CONFIG_HOME:-$HOME/.config}/pi-web/config.json}"
MODE="install"

case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  -h|--help)
    echo "Usage: setup-pi-web.sh [--check]"
    exit 0
    ;;
  *) echo "Usage: setup-pi-web.sh [--check]" >&2; exit 2 ;;
esac

for command in node npm pi curl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Missing command: $command" >&2; exit 1; }
done

node - "$(node --version | sed 's/^v//')" "$(pi --version | head -n 1 | tr -d '[:space:]')" <<'NODE'
const [nodeVersion, piVersion] = process.argv.slice(2);
const parse = (value) => value.split(".").map(Number);
const atLeast = (actual, minimum) => {
  const a = parse(actual), b = parse(minimum);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
};
if (!atLeast(nodeVersion, "22.19.0")) throw new Error(`Node ${nodeVersion}; expected >=22.19.0`);
if (!atLeast(piVersion, "0.84.0")) throw new Error(`Pi ${piVersion}; expected >=0.84.0`);
NODE

GLOBAL_PACKAGE="$(npm root -g)/@jmfederico/pi-web"

if [[ "$MODE" == "install" ]]; then
  npm_args=(install -g --legacy-peer-deps)
  if (( $(npm --version | cut -d. -f1) >= 12 )); then
    npm_args+=(--allow-scripts=node-pty)
  fi
  npm "${npm_args[@]}" "$PI_WEB_SPEC"

  if [[ "$(uname -s)" == "Darwin" ]]; then
    case "$(uname -m)" in
      arm64|aarch64) platform="darwin-arm64" ;;
      x86_64|amd64) platform="darwin-x64" ;;
      *) echo "Unsupported macOS architecture: $(uname -m)" >&2; exit 1 ;;
    esac
    helper="$GLOBAL_PACKAGE/node_modules/node-pty/prebuilds/$platform/spawn-helper"
    [[ -f "$helper" ]] || { echo "Missing node-pty helper: $helper" >&2; exit 1; }
    chmod +x "$helper"
  fi

  mkdir -p "$(dirname "$CONFIG_FILE")"
  node - "$CONFIG_FILE" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
let config = {};
if (fs.existsSync(path)) config = JSON.parse(fs.readFileSync(path, "utf8"));
config = {
  ...config,
  host: "127.0.0.1",
  port: 8504,
  allowedHosts: [],
  pathAccess: { allowedPaths: [] },
  spawnSessions: false,
  subsessions: false,
  askUser: true,
  environmentFacts: false,
  plugins: {
    ...(config.plugins ?? {}),
    git: { enabled: true },
    info: { enabled: true },
    updates: { enabled: false },
    "workspace-tasks": { enabled: false },
    relays: { enabled: false },
  },
};
fs.writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
  chmod 600 "$CONFIG_FILE"

  hash -r
  pi-web install --config "$CONFIG_FILE" --host "$PI_WEB_HOST" --port "$PI_WEB_PORT"
  # Reconcile any LaunchAgent that was written but not yet running without
  # tearing down a healthy peer service during a reinstall.
  pi-web start
  chmod 600 "$CONFIG_FILE"
fi

command -v pi-web >/dev/null 2>&1 || { echo "pi-web is not installed" >&2; exit 1; }
INSTALLED_VERSION="$(node -p "require('$GLOBAL_PACKAGE/package.json').version" 2>/dev/null || true)"
[[ "$INSTALLED_VERSION" == "$PI_WEB_VERSION" ]] || {
  echo "PI WEB ${INSTALLED_VERSION:-missing}; expected $PI_WEB_VERSION" >&2
  exit 1
}

node - "$CONFIG_FILE" <<'NODE'
const fs = require("node:fs");
const configPath = process.argv[2];
const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
if ((fs.statSync(configPath).mode & 0o077) !== 0) throw new Error(`Config permissions are too open: ${configPath}`);
const expected = {
  host: "127.0.0.1", port: 8504, spawnSessions: false,
  subsessions: false, askUser: true, environmentFacts: false,
};
for (const [key, value] of Object.entries(expected)) {
  if (c[key] !== value) throw new Error(`Unexpected ${key}: ${JSON.stringify(c[key])}`);
}
if ((c.pathAccess?.allowedPaths?.length ?? 0) !== 0) throw new Error("External path access must stay empty");
for (const [id, enabled] of Object.entries({ git: true, info: true, updates: false, "workspace-tasks": false, relays: false })) {
  if (c.plugins?.[id]?.enabled !== enabled) throw new Error(`Unexpected plugin state: ${id}`);
}
NODE

SESSION_SOCKET="${PI_WEB_DATA_DIR:-$HOME/.pi-web}/sessiond.sock"
READY=false
for _ in {1..120}; do
  if [[ -S "$SESSION_SOCKET" ]] && curl -fsS "http://$PI_WEB_HOST:$PI_WEB_PORT/api/pi-web/version" >/dev/null 2>&1; then
    READY=true
    break
  fi
  sleep 0.5
done
[[ "$READY" == true ]] || {
  echo "PI WEB services did not become ready; inspect: pi-web logs" >&2
  exit 1
}

pi-web doctor
pi-web status
curl -fsS "http://$PI_WEB_HOST:$PI_WEB_PORT/api/pi-web/version" >/dev/null
curl -fsS "http://$PI_WEB_HOST:$PI_WEB_PORT/" >/dev/null

echo "✓ PI WEB $PI_WEB_VERSION is healthy at http://$PI_WEB_HOST:$PI_WEB_PORT"
echo "  For private phone access, install/login to Tailscale and run:"
echo "  ~/.pi/agent/scripts/setup-pi-web-tailscale.sh"
