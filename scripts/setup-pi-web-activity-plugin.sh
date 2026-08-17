#!/usr/bin/env bash
# Safe installer for the browser-only PI WEB Activity plugin.
# Requires: @jmfederico/pi-web@1.202608.1 with browser plugin API v2.
set -euo pipefail

# Restrictive umask for secure file creation
umask 077

readonly PI_WEB_VERSION="1.202608.1"
readonly PLUGIN_ID="activity"
readonly PLUGIN_SOURCE_REL="pi-web-plugins/activity"

CHECK_MODE=0
for arg in "$@"; do
    case "$arg" in
        --check) CHECK_MODE=1 ;;
        *) echo "ERROR: Unknown argument: $arg" >&2; exit 2 ;;
    esac
done

fail() { echo "ERROR: $*" >&2; exit 1; }
info() { echo "$*"; }

# Repo root = parent of this script's directory (scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLUGIN_SOURCE="$REPO_ROOT/$PLUGIN_SOURCE_REL"

PLUGIN_LINK_DIR="$HOME/.pi-web/plugins"
PLUGIN_LINK="$PLUGIN_LINK_DIR/$PLUGIN_ID"
CONFIG_DIR="$HOME/.config/pi-web"
CONFIG_FILE="$CONFIG_DIR/config.json"

# Locate global pi-web package using npm root -g
# Test-only override: PI_WEB_TEST_GLOBAL_ROOT (validated to exist)
if [[ -n "${PI_WEB_TEST_GLOBAL_ROOT:-}" ]]; then
    PI_WEB_GLOBAL_ROOT="$PI_WEB_TEST_GLOBAL_ROOT"
    if [[ ! -d "$PI_WEB_GLOBAL_ROOT" ]]; then
        fail "PI_WEB_TEST_GLOBAL_ROOT does not exist: $PI_WEB_GLOBAL_ROOT"
    fi
else
    if ! PI_WEB_GLOBAL_ROOT="$(npm root -g 2>/dev/null)"; then
        fail "Failed to determine npm global root. Is npm installed?"
    fi
fi

PI_WEB_ROOT="$PI_WEB_GLOBAL_ROOT/@jmfederico/pi-web"

if [[ ! -f "$PI_WEB_ROOT/package.json" ]]; then
    fail "pi-web package not found at $PI_WEB_ROOT. Install @jmfederico/pi-web@$PI_WEB_VERSION first (npm install -g @jmfederico/pi-web@$PI_WEB_VERSION)."
fi

# Verify exact version
PI_WEB_VERSION_INSTALLED="$(PI_WEB_VERSION_OF="$PI_WEB_ROOT/package.json" node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync(process.env.PI_WEB_VERSION_OF, "utf8"));
  console.log(pkg.version);
')" || fail "Failed to read pi-web version from $PI_WEB_ROOT/package.json."

if [[ "$PI_WEB_VERSION_INSTALLED" != "$PI_WEB_VERSION" ]]; then
    fail "pi-web version mismatch: found $PI_WEB_VERSION_INSTALLED, required exactly $PI_WEB_VERSION. Install with: npm install -g @jmfederico/pi-web@$PI_WEB_VERSION"
fi

# Verify browser plugin API v2 from installed declarations
API_DECL_FILE="$PI_WEB_ROOT/dist/plugin-api.d.ts"
if [[ ! -f "$API_DECL_FILE" ]]; then
    fail "pi-web API declarations not found at $API_DECL_FILE. Reinstall pi-web@$PI_WEB_VERSION."
fi

# Look for the PiWebPlugin apiVersion: 2 contract
if ! API_DECL_FILE="$API_DECL_FILE" node -e '
  const fs = require("fs");
  const content = fs.readFileSync(process.env.API_DECL_FILE, "utf8");
  const hasV2Plugin = /interface\s+PiWebPlugin\b[\s\S]*?apiVersion:\s*2/.test(content);
  const hasV2Context = /interface\s+PluginActivationContext\b[\s\S]*?apiVersion:\s*2/.test(content);
  if (!(hasV2Plugin && hasV2Context)) process.exit(1);
' 2>/dev/null; then
    fail "pi-web API v2 contract not found in $API_DECL_FILE. Required version: $PI_WEB_VERSION"
fi

# Verify catalog (needed for plugin discovery)
CATALOG_FILE="$PI_WEB_ROOT/dist/server/piWebPluginCatalog.js"
if [[ ! -f "$CATALOG_FILE" ]]; then
    fail "pi-web plugin catalog not found at $CATALOG_FILE. Reinstall pi-web@$PI_WEB_VERSION."
fi

info "✓ pi-web@$PI_WEB_VERSION installed with browser plugin API v2"

# Verify plugin source exists and has required metadata
verify_plugin_source() {
    local src="$1"
    if [[ ! -d "$src" ]]; then
        fail "Plugin source directory not found: $src"
    fi
    local pkg_json="$src/package.json"
    if [[ ! -f "$pkg_json" ]]; then
        fail "Plugin source missing package.json at $pkg_json"
    fi
    PLUGIN_SOURCE_CHECK="$src" node -e '
      const fs = require("fs");
      const path = require("path");
      const source = fs.realpathSync(process.env.PLUGIN_SOURCE_CHECK);
      const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf8"));
      if (!pkg.piWeb || !Array.isArray(pkg.piWeb.plugins) || pkg.piWeb.plugins.length === 0) {
        console.error("missing piWeb.plugins[]");
        process.exit(1);
      }
      const entry = pkg.piWeb.plugins.find(e => e && e.id === "activity");
      if (!entry || typeof entry.module !== "string" || !entry.module ||
          typeof entry.browserRoot !== "string" || !entry.browserRoot ||
          Object.prototype.hasOwnProperty.call(entry, "serverModule")) {
        console.error("activity must be a browser-only plugin with module + browserRoot");
        process.exit(1);
      }
      const browserRoot = fs.realpathSync(path.resolve(source, entry.browserRoot));
      const browserModule = fs.realpathSync(path.resolve(source, entry.module));
      const inside = (root, target) => {
        const relative = path.relative(root, target);
        return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
      };
      if (!inside(source, browserRoot) || !inside(browserRoot, browserModule) || !fs.statSync(browserModule).isFile()) {
        console.error("activity browser paths escape the package or module is not a file");
        process.exit(1);
      }
    ' || fail "Plugin source at $src has invalid or incomplete browser-only metadata/files."
}

# --- CHECK MODE: read-only verification ---
if [[ $CHECK_MODE -eq 1 ]]; then
    info "Running --check (read-only verification)..."

    verify_plugin_source "$PLUGIN_SOURCE"

    # Symlink verification
    if [[ ! -e "$PLUGIN_LINK" && ! -L "$PLUGIN_LINK" ]]; then
        fail "Plugin symlink not installed at $PLUGIN_LINK"
    fi
    if [[ ! -L "$PLUGIN_LINK" ]]; then
        fail "Plugin target exists but is not a symlink: $PLUGIN_LINK (refusing to treat non-symlink as installed)"
    fi
    LINK_TARGET="$(readlink "$PLUGIN_LINK")"
    RESOLVED_TARGET="$(cd "$PLUGIN_LINK_DIR" && cd "$(dirname "$LINK_TARGET")" 2>/dev/null && echo "$(pwd)/$(basename "$LINK_TARGET")")" || RESOLVED_TARGET="$LINK_TARGET"
    if [[ "$RESOLVED_TARGET" != "$PLUGIN_SOURCE" ]]; then
        fail "Plugin symlink at $PLUGIN_LINK points to $LINK_TARGET (resolved: $RESOLVED_TARGET), expected $PLUGIN_SOURCE"
    fi

    # Plugin discovery prerequisites: dir name must equal plugin id
    if [[ "$(basename "$PLUGIN_LINK")" != "$PLUGIN_ID" ]]; then
        fail "Plugin link basename $(basename "$PLUGIN_LINK") does not match plugin id $PLUGIN_ID"
    fi

    # Config file checks
    if [[ ! -f "$CONFIG_FILE" ]]; then
        fail "Config file not found at $CONFIG_FILE"
    fi

    # Check enabled flag without printing secrets
    ENABLED_OK="$(CONFIG_FILE="$CONFIG_FILE" node -e '
      const fs = require("fs");
      const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE, "utf8"));
      console.log(cfg.plugins && cfg.plugins.activity && cfg.plugins.activity.enabled === true ? "yes" : "no");
    ')" || fail "Failed to parse config at $CONFIG_FILE"
    if [[ "$ENABLED_OK" != "yes" ]]; then
        fail "Config at $CONFIG_FILE does not enable plugins.activity (expected plugins.activity.enabled = true)"
    fi

    # Mode must be 0600
    CONFIG_MODE="$(stat -f "%Lp" "$CONFIG_FILE" 2>/dev/null || stat -c "%a" "$CONFIG_FILE" 2>/dev/null || echo "unknown")"
    if [[ "$CONFIG_MODE" != "600" ]]; then
        fail "Config file at $CONFIG_FILE has mode $CONFIG_MODE, expected 600"
    fi

    info "✓ --check passed: version, API v2, source, symlink, config enablement, mode 0600 all verified."
    exit 0
fi

# --- NORMAL MODE: install ---
info "Installing activity plugin..."

verify_plugin_source "$PLUGIN_SOURCE"

# Validate config exists and is parseable before any side effect.
if [[ ! -f "$CONFIG_FILE" ]]; then
    fail "Config file not found at $CONFIG_FILE. Initialize it first (e.g., run pi-web-server once)."
fi
if ! CONFIG_FILE_CHECK="$CONFIG_FILE" node -e '
  const fs = require("fs");
  JSON.parse(fs.readFileSync(process.env.CONFIG_FILE_CHECK, "utf8"));
' 2>/dev/null; then
    fail "Config file at $CONFIG_FILE is not valid JSON"
fi

# Preflight the destination before preparing or committing the config. A
# foreign target must leave the existing config byte-for-byte untouched.
LINK_NEEDED=0
if [[ -L "$PLUGIN_LINK" ]]; then
    LINK_TARGET="$(readlink "$PLUGIN_LINK")"
    RESOLVED_TARGET="$(cd "$PLUGIN_LINK_DIR" && cd "$(dirname "$LINK_TARGET")" 2>/dev/null && echo "$(pwd)/$(basename "$LINK_TARGET")")" || RESOLVED_TARGET="$LINK_TARGET"
    if [[ "$RESOLVED_TARGET" != "$PLUGIN_SOURCE" ]]; then
        fail "Plugin symlink at $PLUGIN_LINK points elsewhere ($LINK_TARGET). Refusing to overwrite a foreign target."
    fi
elif [[ -e "$PLUGIN_LINK" ]]; then
    fail "Plugin target exists and is not a symlink: $PLUGIN_LINK. Refusing to overwrite a foreign/non-symlink target."
else
    LINK_NEEDED=1
fi

# Prepare the config securely, but do not publish it until the no-clobber
# symlink step succeeds. Roll back only a link created by this invocation if
# the final config rename fails.
TEMP_CONFIG="$(mktemp "${CONFIG_DIR}/.config.json.XXXXXX")"
LINK_CREATED=0
CONFIG_COMMITTED=0
cleanup_install() {
    rm -f "$TEMP_CONFIG"
    if [[ "$LINK_CREATED" -eq 1 && "$CONFIG_COMMITTED" -eq 0 && -L "$PLUGIN_LINK" ]]; then
        rm -f "$PLUGIN_LINK"
    fi
}
trap cleanup_install EXIT

CONFIG_FILE_IN="$CONFIG_FILE" CONFIG_FILE_OUT="$TEMP_CONFIG" node -e '
  const fs = require("fs");
  const cfg = JSON.parse(fs.readFileSync(process.env.CONFIG_FILE_IN, "utf8"));
  if (!cfg.plugins || typeof cfg.plugins !== "object" || Array.isArray(cfg.plugins)) cfg.plugins = {};
  if (!cfg.plugins.activity || typeof cfg.plugins.activity !== "object" || Array.isArray(cfg.plugins.activity)) cfg.plugins.activity = {};
  cfg.plugins.activity.enabled = true;
  fs.writeFileSync(process.env.CONFIG_FILE_OUT, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
' || fail "Failed to prepare config update"
chmod 0600 "$TEMP_CONFIG"

if [[ "$LINK_NEEDED" -eq 1 ]]; then
    mkdir -p "$PLUGIN_LINK_DIR"
    # Direct creation is atomic and no-clobber. A race that creates the target
    # first makes ln fail; cleanup never removes that foreign target.
    if ! ln -s "$PLUGIN_SOURCE" "$PLUGIN_LINK" 2>/dev/null; then
        fail "Failed to create symlink $PLUGIN_LINK -> $PLUGIN_SOURCE"
    fi
    LINK_CREATED=1
fi

if ! mv -f "$TEMP_CONFIG" "$CONFIG_FILE"; then
    fail "Failed to atomically update config at $CONFIG_FILE"
fi
CONFIG_COMMITTED=1
trap - EXIT

if [[ "$LINK_NEEDED" -eq 1 ]]; then
    info "✓ Created symlink $PLUGIN_LINK -> $PLUGIN_SOURCE"
else
    info "✓ Plugin symlink already points to source (idempotent)."
fi
info "✓ Updated config: plugins.activity.enabled = true (mode 0600)"
info ""
info "Installation complete."
info "Browser hard refresh (Ctrl+Shift+R / Cmd+Shift+R) is required to load the plugin."
info "Extension /reload is a separate later step."
