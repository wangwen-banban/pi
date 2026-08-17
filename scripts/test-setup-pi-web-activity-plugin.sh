#!/usr/bin/env bash
# Self-contained tests for setup-pi-web-activity-plugin.sh
# Uses temporary HOME and fake pi-web installation; never mutates real config/home.
set -euo pipefail

# Test framework
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "${GREEN}✓ PASS${NC}: $1"
}

fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo -e "${RED}✗ FAIL${NC}: $1"
    if [[ -n "${2:-}" ]]; then
        echo "  Reason: $2"
    fi
}

info() {
    echo -e "${YELLOW}ℹ${NC} $1"
}

# Create a temporary test environment
setup_test_env() {
    local test_name="$1"
    local test_dir
    test_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-web-activity-test.XXXXXX")"

    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local fake_global_root="$fake_repo/fake_global_root"
    local fake_pi_web="$fake_global_root/@jmfederico/pi-web"
    local fake_plugin_source="$fake_repo/pi-web-plugins/activity"

    mkdir -p "$fake_home/.pi-web/plugins"
    mkdir -p "$fake_home/.config/pi-web"
    mkdir -p "$fake_plugin_source/src"
    mkdir -p "$fake_pi_web/dist/server"

    # Create fake pi-web package.json with correct version
    cat > "$fake_pi_web/package.json" <<'PKGJSON'
{
  "name": "@jmfederico/pi-web",
  "version": "1.202608.1",
  "type": "module"
}
PKGJSON

    # Create fake API declarations with v2 contract
    cat > "$fake_pi_web/dist/plugin-api.d.ts" <<'APIDECL'
export interface PiWebPlugin {
    apiVersion: 2;
    name: string;
    activate: (context: PluginActivationContext) => PluginActivationResult;
}
export interface PluginActivationContext {
    readonly apiVersion: 2;
    readonly pluginId: string;
    readonly runtimePluginId: string;
}
export interface PluginActivationResult {
    contributions: PluginContributions;
}
export interface PluginContributions {
    actions?: PluginAction[];
}
export interface PluginAction {
    id: string;
    title: string;
    run: () => void;
}
APIDECL

    # Create fake catalog
    cat > "$fake_pi_web/dist/server/piWebPluginCatalog.js" <<'CATALOG'
export class PiWebPluginCatalog {
    constructor() {}
    async snapshot() { return { plugins: [], diagnostics: [] }; }
}
CATALOG

    # Create fake plugin source with valid metadata
    cat > "$fake_plugin_source/package.json" <<'PLUGINPKG'
{
  "name": "activity-plugin",
  "version": "1.0.0",
  "piWeb": {
    "plugins": [
      {
        "id": "activity",
        "module": "./src/browser.js",
        "browserRoot": ".",
        "machineSpecific": false
      }
    ]
  }
}
PLUGINPKG

    cat > "$fake_plugin_source/src/browser.js" <<'BROWSERJS'
export const apiVersion = 2;
export const name = "activity";
export function activate(context) {
    return { contributions: {} };
}
BROWSERJS

    # Create initial config
    cat > "$fake_home/.config/pi-web/config.json" <<'CONFIG'
{
  "host": "127.0.0.1",
  "port": 8504,
  "spawnSessions": false,
  "plugins": {
    "git": { "enabled": true },
    "info": { "enabled": true }
  }
}
CONFIG

    # Copy the installer script to fake repo
    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    mkdir -p "$fake_repo/scripts"
    cp "$script_dir/setup-pi-web-activity-plugin.sh" "$fake_repo/scripts/"
    chmod +x "$fake_repo/scripts/setup-pi-web-activity-plugin.sh"

    echo "$test_dir"
}

cleanup_test_env() {
    local test_dir="$1"
    rm -rf "$test_dir"
}

# Helper to run installer with fake environment
run_installer() {
    local fake_repo="$1"
    shift
    local fake_home="$1"
    shift

    # Test-only override: provide explicit global root instead of using npm root -g
    (
        cd "$fake_repo"
        HOME="$fake_home" \
        PI_WEB_TEST_GLOBAL_ROOT="$fake_repo/fake_global_root" \
        bash "$fake_repo/scripts/setup-pi-web-activity-plugin.sh" "$@"
    )
}

# Helper to get file mode (cross-platform macOS/Linux)
get_file_mode() {
    local file="$1"
    stat -f "%Lp" "$file" 2>/dev/null || stat -c "%a" "$file" 2>/dev/null || echo "unknown"
}

# ============================================================================
# TEST CASES
# ============================================================================

test_fresh_install() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Fresh install"

    local test_dir
    test_dir="$(setup_test_env "fresh-install")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    if ! run_installer "$fake_repo" "$fake_home" 2>&1; then
        fail "Fresh install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify symlink created
    if [[ ! -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Symlink not created"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify config updated
    local enabled
    enabled="$(HOME="$fake_home" node -e 'const c = require(process.env.HOME + "/.config/pi-web/config.json"); console.log(c.plugins.activity.enabled === true ? "yes" : "no");')"
    if [[ "$enabled" != "yes" ]]; then
        fail "Config not updated"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify mode 0600
    local mode
    mode="$(get_file_mode "$fake_home/.config/pi-web/config.json")"
    if [[ "$mode" != "600" ]]; then
        fail "Config mode is $mode, expected 600"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Fresh install"
    cleanup_test_env "$test_dir"
}

test_idempotence() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Idempotence (run twice)"

    local test_dir
    test_dir="$(setup_test_env "idempotence")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # First run
    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "First install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Second run (should succeed without error)
    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Second install failed (not idempotent)"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Idempotence"
    cleanup_test_env "$test_dir"
}

test_check_mode() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: --check mode"

    local test_dir
    test_dir="$(setup_test_env "check-mode")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Install first
    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Initial install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Run --check
    if ! run_installer "$fake_repo" "$fake_home" --check >/dev/null 2>&1; then
        fail "--check mode failed after successful install"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "--check mode"
    cleanup_test_env "$test_dir"
}

test_check_mode_fails_before_install() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: --check fails before install"

    local test_dir
    test_dir="$(setup_test_env "check-before-install")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Run --check without installing (should fail)
    if run_installer "$fake_repo" "$fake_home" --check >/dev/null 2>&1; then
        fail "--check should fail before install"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "--check fails before install"
    cleanup_test_env "$test_dir"
}

test_config_preservation() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Config preserves unrelated keys"

    local test_dir
    test_dir="$(setup_test_env "config-preservation")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Add extra keys to config
    cat > "$fake_home/.config/pi-web/config.json" <<'CONFIG'
{
  "host": "127.0.0.1",
  "port": 8504,
  "spawnSessions": false,
  "askUser": true,
  "customKey": "customValue",
  "plugins": {
    "git": { "enabled": true },
    "info": { "enabled": true },
    "updates": { "enabled": false }
  }
}
CONFIG

    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify all keys preserved
    local preserved
    preserved="$(HOME="$fake_home" node -e '
      const c = require(process.env.HOME + "/.config/pi-web/config.json");
      const ok = c.host === "127.0.0.1" &&
                 c.port === 8504 &&
                 c.spawnSessions === false &&
                 c.askUser === true &&
                 c.customKey === "customValue" &&
                 c.plugins.git.enabled === true &&
                 c.plugins.info.enabled === true &&
                 c.plugins.updates.enabled === false &&
                 c.plugins.activity.enabled === true;
      console.log(ok ? "yes" : "no");
    ')"

    if [[ "$preserved" != "yes" ]]; then
        fail "Config keys not preserved"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Config preservation"
    cleanup_test_env "$test_dir"
}

test_mode_600() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Config mode is 0600"

    local test_dir
    test_dir="$(setup_test_env "mode-600")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Set config to world-readable first
    chmod 0644 "$fake_home/.config/pi-web/config.json"

    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify mode changed to 0600
    local mode
    mode="$(get_file_mode "$fake_home/.config/pi-web/config.json")"
    if [[ "$mode" != "600" ]]; then
        fail "Config mode is $mode, expected 600"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Config mode 0600"
    cleanup_test_env "$test_dir"
}

test_paths_with_spaces() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Paths with spaces"

    # Create test env with spaces in path
    local test_dir
    test_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-web test with spaces.XXXXXX")"

    local fake_home="$test_dir/home with spaces"
    local fake_repo="$test_dir/repo with spaces"
    local fake_global_root="$fake_repo/fake global root"
    local fake_pi_web="$fake_global_root/@jmfederico/pi-web"
    local fake_plugin_source="$fake_repo/pi-web-plugins/activity"

    mkdir -p "$fake_home/.pi-web/plugins"
    mkdir -p "$fake_home/.config/pi-web"
    mkdir -p "$fake_plugin_source/src"
    mkdir -p "$fake_pi_web/dist/server"

    # Create fake pi-web
    cat > "$fake_pi_web/package.json" <<'PKGJSON'
{"name":"@jmfederico/pi-web","version":"1.202608.1","type":"module"}
PKGJSON

    cat > "$fake_pi_web/dist/plugin-api.d.ts" <<'APIDECL'
export interface PiWebPlugin { apiVersion: 2; }
export interface PluginActivationContext { readonly apiVersion: 2; }
APIDECL

    cat > "$fake_pi_web/dist/server/piWebPluginCatalog.js" <<'CATALOG'
export class PiWebPluginCatalog {}
CATALOG

    cat > "$fake_plugin_source/package.json" <<'PLUGINPKG'
{"name":"activity","piWeb":{"plugins":[{"id":"activity","module":"./src/browser.js","browserRoot":"."}]}}
PLUGINPKG

    cat > "$fake_plugin_source/src/browser.js" <<'BROWSERJS'
export const apiVersion = 2;
BROWSERJS

    cat > "$fake_home/.config/pi-web/config.json" <<'CONFIG'
{"host":"127.0.0.1","plugins":{}}
CONFIG

    local script_dir
    script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    mkdir -p "$fake_repo/scripts"
    cp "$script_dir/setup-pi-web-activity-plugin.sh" "$fake_repo/scripts/"
    chmod +x "$fake_repo/scripts/setup-pi-web-activity-plugin.sh"

    # Run installer with test-only global root override
    if ! (
        cd "$fake_repo"
        HOME="$fake_home" \
        PI_WEB_TEST_GLOBAL_ROOT="$fake_global_root" \
        bash "$fake_repo/scripts/setup-pi-web-activity-plugin.sh"
    ) >/dev/null 2>&1; then
        fail "Install failed with spaces in paths"
        rm -rf "$test_dir"
        return
    fi

    # Verify symlink created
    if [[ ! -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Symlink not created with spaces in paths"
        rm -rf "$test_dir"
        return
    fi

    pass "Paths with spaces"
    rm -rf "$test_dir"
}

test_version_mismatch() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Version mismatch detection"

    local test_dir
    test_dir="$(setup_test_env "version-mismatch")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local fake_pi_web="$fake_repo/fake_global_root/@jmfederico/pi-web"

    # Change version to wrong one
    cat > "$fake_pi_web/package.json" <<'PKGJSON'
{"name":"@jmfederico/pi-web","version":"1.202607.1","type":"module"}
PKGJSON

    # Should fail
    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Should fail with wrong version"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Version mismatch detection"
    cleanup_test_env "$test_dir"
}

test_refuse_foreign_symlink() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Refuse to overwrite foreign symlink"

    local test_dir
    test_dir="$(setup_test_env "foreign-symlink")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Create a foreign symlink and snapshot config; refusal must be mutation-free.
    local foreign_target="$test_dir/foreign"
    mkdir -p "$foreign_target"
    ln -s "$foreign_target" "$fake_home/.pi-web/plugins/activity"
    local config_before
    config_before="$(cksum < "$fake_home/.config/pi-web/config.json")"

    # Should fail
    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Should refuse foreign symlink"
        cleanup_test_env "$test_dir"
        return
    fi

    if [[ "$(cksum < "$fake_home/.config/pi-web/config.json")" != "$config_before" ]]; then
        fail "Foreign symlink refusal modified config"
        cleanup_test_env "$test_dir"
        return
    fi
    if [[ "$(readlink "$fake_home/.pi-web/plugins/activity")" != "$foreign_target" ]]; then
        fail "Foreign symlink refusal changed the target"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Refuse foreign symlink"
    cleanup_test_env "$test_dir"
}

test_refuse_non_symlink_target() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Refuse to overwrite non-symlink target"

    local test_dir
    test_dir="$(setup_test_env "non-symlink")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Create a regular directory (not symlink); refusal must not alter config.
    mkdir -p "$fake_home/.pi-web/plugins/activity"
    local config_before
    config_before="$(cksum < "$fake_home/.config/pi-web/config.json")"

    # Should fail
    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Should refuse non-symlink target"
        cleanup_test_env "$test_dir"
        return
    fi

    if [[ "$(cksum < "$fake_home/.config/pi-web/config.json")" != "$config_before" ]]; then
        fail "Non-symlink refusal modified config"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Refuse non-symlink target"
    cleanup_test_env "$test_dir"
}

test_missing_plugin_source() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Fail on missing plugin source"

    local test_dir
    test_dir="$(setup_test_env "missing-source")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Remove plugin source
    rm -rf "$fake_repo/pi-web-plugins/activity"

    # Should fail
    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Should fail on missing plugin source"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Fail on missing plugin source"
    cleanup_test_env "$test_dir"
}

test_missing_plugin_module() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Fail on missing browser module"

    local test_dir
    test_dir="$(setup_test_env "missing-browser-module")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    rm -f "$fake_repo/pi-web-plugins/activity/src/browser.js"

    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Should fail when declared browser module is missing"
        cleanup_test_env "$test_dir"
        return
    fi
    if [[ -e "$fake_home/.pi-web/plugins/activity" || -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Missing browser module left a plugin link"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Fail on missing browser module"
    cleanup_test_env "$test_dir"
}

test_missing_plugin_metadata() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Fail on missing plugin metadata"

    local test_dir
    test_dir="$(setup_test_env "missing-metadata")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Remove package.json from plugin source
    rm -f "$fake_repo/pi-web-plugins/activity/package.json"

    # Should fail
    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Should fail on missing plugin metadata"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Fail on missing plugin metadata"
    cleanup_test_env "$test_dir"
}

# ============================================================================
# NEW HARDENING TESTS
# ============================================================================

test_global_root_resolution() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Global root resolution via test-only override"

    local test_dir
    test_dir="$(setup_test_env "global-root-resolution")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local fake_global_root="$fake_repo/fake_global_root"

    # The test-only override should make the installer find pi-web at
    # $fake_global_root/@jmfederico/pi-web without using npm root -g
    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Installer did not honor PI_WEB_TEST_GLOBAL_ROOT override"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify symlink was created (proves package was found at overridden root)
    if [[ ! -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Symlink not created with test override (override not honored)"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Global root resolution via test-only override"
    cleanup_test_env "$test_dir"
}

test_global_root_override_validated() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Test-only override validated to exist"

    local test_dir
    test_dir="$(setup_test_env "override-validated")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Point override at a non-existent directory
    if (
        cd "$fake_repo"
        HOME="$fake_home" \
        PI_WEB_TEST_GLOBAL_ROOT="/nonexistent/fake/root" \
        bash "$fake_repo/scripts/setup-pi-web-activity-plugin.sh"
    ) >/dev/null 2>&1; then
        fail "Installer should reject non-existent PI_WEB_TEST_GLOBAL_ROOT"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Test-only override validated to exist"
    cleanup_test_env "$test_dir"
}

test_malformed_config_leaves_no_symlink() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Malformed config leaves no symlink"

    local test_dir
    test_dir="$(setup_test_env "malformed-config")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"

    # Write malformed JSON to config
    echo "{ this is not valid json " > "$fake_home/.config/pi-web/config.json"

    # Should fail due to malformed config
    if run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Installer should fail on malformed config"
        cleanup_test_env "$test_dir"
        return
    fi

    # No symlink should have been created (config validation happens before symlink)
    if [[ -e "$fake_home/.pi-web/plugins/activity" || -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Symlink was created despite malformed config"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify malformed config was not modified
    if [[ -f "$fake_home/.pi-web/plugins/plugins" ]]; then
        fail "Unexpected artifacts created after failed install"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Malformed config leaves no symlink"
    cleanup_test_env "$test_dir"
}

test_secure_temp_config_mode() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Secure temp config mode (0600 before rename)"

    local test_dir
    test_dir="$(setup_test_env "secure-temp")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local config_dir="$fake_home/.config/pi-web"

    # Watch for temp files during install to verify they get mode 0600
    # The final config must be 0600, and with umask 077 the temp file was created restricted
    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify final config is 0600
    local mode
    mode="$(get_file_mode "$config_dir/config.json")"
    if [[ "$mode" != "600" ]]; then
        fail "Final config mode is $mode, expected 600"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify no leftover temp files in config dir
    local leftover_temps
    leftover_temps="$(find "$config_dir" -name '.config.json.*' -type f 2>/dev/null | head -1)"
    if [[ -n "$leftover_temps" ]]; then
        fail "Leftover temp files found: $leftover_temps"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Secure temp config mode (0600 before rename)"
    cleanup_test_env "$test_dir"
}

test_secure_final_config_mode() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Secure final config mode regardless of prior mode"

    local test_dir
    test_dir="$(setup_test_env "secure-final-mode")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local config_file="$fake_home/.config/pi-web/config.json"

    # Start with very permissive mode
    chmod 0777 "$config_file"

    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Final mode must be exactly 0600
    local mode
    mode="$(get_file_mode "$config_file")"
    if [[ "$mode" != "600" ]]; then
        fail "Final config mode is $mode, expected 600 (not hardened from $mode)"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Secure final config mode regardless of prior mode"
    cleanup_test_env "$test_dir"
}

test_check_mode_is_read_only() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: --check mode is strictly read-only"

    local test_dir
    test_dir="$(setup_test_env "check-readonly")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local config_file="$fake_home/.config/pi-web/config.json"

    # Install first
    if ! run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Initial install failed"
        cleanup_test_env "$test_dir"
        return
    fi

    # Record config content and mode before --check
    local content_before
    content_before="$(cat "$config_file")"
    local mode_before
    mode_before="$(get_file_mode "$config_file")"

    # Run --check (should succeed since install was done)
    if ! run_installer "$fake_repo" "$fake_home" --check >/dev/null 2>&1; then
        fail "--check failed after successful install"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify nothing changed
    local content_after
    content_after="$(cat "$config_file")"
    local mode_after
    mode_after="$(get_file_mode "$config_file")"

    if [[ "$content_before" != "$content_after" ]]; then
        fail "--check modified config content"
        cleanup_test_env "$test_dir"
        return
    fi

    if [[ "$mode_before" != "$mode_after" ]]; then
        fail "--check modified config mode"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify symlink unchanged
    if [[ ! -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Symlink removed by --check"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "--check mode is strictly read-only"
    cleanup_test_env "$test_dir"
}

test_config_commit_failure_rolls_back_link() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Config commit failure rolls back newly-created symlink"

    local test_dir
    test_dir="$(setup_test_env "config-commit-rollback")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local fake_bin="$test_dir/fake-bin"
    mkdir -p "$fake_bin"
    cat > "$fake_bin/mv" <<'FAKEMV'
#!/usr/bin/env bash
exit 1
FAKEMV
    chmod +x "$fake_bin/mv"
    local config_before
    config_before="$(cksum < "$fake_home/.config/pi-web/config.json")"

    if PATH="$fake_bin:$PATH" run_installer "$fake_repo" "$fake_home" >/dev/null 2>&1; then
        fail "Installer should fail when atomic config commit fails"
        cleanup_test_env "$test_dir"
        return
    fi
    if [[ -e "$fake_home/.pi-web/plugins/activity" || -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "New symlink was not rolled back after config commit failure"
        cleanup_test_env "$test_dir"
        return
    fi
    if [[ "$(cksum < "$fake_home/.config/pi-web/config.json")" != "$config_before" ]]; then
        fail "Failed config commit changed the original config"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Config commit failure rolls back newly-created symlink"
    cleanup_test_env "$test_dir"
}

test_no_node_path_dependency() {
    TESTS_RUN=$((TESTS_RUN + 1))
    info "Test: Installer does not depend on NODE_PATH"

    local test_dir
    test_dir="$(setup_test_env "no-node-path")"
    local fake_home="$test_dir/home"
    local fake_repo="$test_dir/repo"
    local fake_global_root="$fake_repo/fake_global_root"

    # Run with NODE_PATH explicitly unset (should still work via test override)
    if (
        cd "$fake_repo"
        HOME="$fake_home" \
        PI_WEB_TEST_GLOBAL_ROOT="$fake_global_root" \
        NODE_PATH="" \
        bash "$fake_repo/scripts/setup-pi-web-activity-plugin.sh"
    ) >/dev/null 2>&1; then
        : # expected success
    else
        fail "Installer failed without NODE_PATH (it should not depend on it)"
        cleanup_test_env "$test_dir"
        return
    fi

    # Verify symlink created
    if [[ ! -L "$fake_home/.pi-web/plugins/activity" ]]; then
        fail "Symlink not created when NODE_PATH is unset"
        cleanup_test_env "$test_dir"
        return
    fi

    pass "Installer does not depend on NODE_PATH"
    cleanup_test_env "$test_dir"
}

# ============================================================================
# RUN ALL TESTS
# ============================================================================

echo "======================================================================"
echo "Running PI WEB Activity Plugin Installer Tests"
echo "======================================================================"
echo ""

test_fresh_install
test_idempotence
test_check_mode
test_check_mode_fails_before_install
test_config_preservation
test_mode_600
test_paths_with_spaces
test_version_mismatch
test_refuse_foreign_symlink
test_refuse_non_symlink_target
test_missing_plugin_source
test_missing_plugin_module
test_missing_plugin_metadata
test_global_root_resolution
test_global_root_override_validated
test_malformed_config_leaves_no_symlink
test_secure_temp_config_mode
test_secure_final_config_mode
test_check_mode_is_read_only
test_config_commit_failure_rolls_back_link
test_no_node_path_dependency

echo ""
echo "======================================================================"
echo "Test Summary"
echo "======================================================================"
echo "Tests run:    $TESTS_RUN"
echo -e "Tests passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Tests failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [[ $TESTS_FAILED -eq 0 ]]; then
    echo -e "${GREEN}All tests passed!${NC}"
    exit 0
else
    echo -e "${RED}Some tests failed.${NC}"
    exit 1
fi
