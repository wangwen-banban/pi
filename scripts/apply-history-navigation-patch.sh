#!/usr/bin/env bash
set -euo pipefail

SUPPORTED_VERSION="0.84.1"
STOCK_SHA256="a384c140d84e5352605250fab0e1284add133dbdda1e986419c4a0778ffa0853"
PATCHED_SHA256="5a765439ec4f415d9a9720d6651ddd693333ee2f6899be6efaca63eb6b2c7aaf"
TARGET_REL="dist/components/editor.js"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCH_FILE="$AGENT_DIR/patches/pi-history-navigation/$SUPPORTED_VERSION/history-navigation.patch"
MODE="apply"

usage() {
  cat <<'EOF'
Usage: apply-history-navigation-patch.sh [--check]

Apply or verify the shell-like prompt history navigation patch for pi 0.84.1.
The installed pi package is resolved through npm/command lookup; set
PI_PACKAGE_ROOT to test or patch a specific coding-agent package root.
EOF
}

case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "Neither shasum nor sha256sum is available" >&2
    exit 1
  fi
}

resolve_package_root() {
  if [[ -n "${PI_PACKAGE_ROOT:-}" ]]; then
    printf '%s\n' "$PI_PACKAGE_ROOT"
    return
  fi

  local npm_root candidate pi_bin resolved
  npm_root="$(npm root -g 2>/dev/null || true)"
  candidate="$npm_root/@earendil-works/pi-coding-agent"
  if [[ -f "$candidate/package.json" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  pi_bin="$(command -v pi 2>/dev/null || true)"
  if [[ -n "$pi_bin" ]]; then
    resolved="$(python3 - "$pi_bin" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
    candidate="$(cd "$(dirname "$resolved")/.." 2>/dev/null && pwd || true)"
    if [[ -f "$candidate/package.json" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  fi

  echo "Cannot locate @earendil-works/pi-coding-agent. Set PI_PACKAGE_ROOT explicitly." >&2
  exit 1
}

resolve_tui_root() {
  node - "$1" <<'NODE'
const path = require("node:path");
const { createRequire } = require("node:module");
const agentRoot = process.argv[2];
const requireFromAgent = createRequire(path.join(agentRoot, "package.json"));
const packageJson = requireFromAgent.resolve("@earendil-works/pi-tui/package.json");
process.stdout.write(path.dirname(packageJson));
NODE
}

PACKAGE_ROOT="$(resolve_package_root)"
PACKAGE_JSON="$PACKAGE_ROOT/package.json"
[[ -f "$PATCH_FILE" ]] || { echo "Missing patch: $PATCH_FILE" >&2; exit 1; }
[[ -f "$PACKAGE_JSON" ]] || { echo "Missing package.json: $PACKAGE_JSON" >&2; exit 1; }

VERSION="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(p.version||""))' "$PACKAGE_JSON")"
if [[ "$VERSION" != "$SUPPORTED_VERSION" ]]; then
  echo "Unsupported pi version: $VERSION (expected $SUPPORTED_VERSION). Refusing to modify the installation." >&2
  exit 1
fi

TUI_ROOT="$(resolve_tui_root "$PACKAGE_ROOT")"
TUI_PACKAGE_JSON="$TUI_ROOT/package.json"
[[ -f "$TUI_PACKAGE_JSON" ]] || { echo "Missing resolved pi-tui package: $TUI_PACKAGE_JSON" >&2; exit 1; }
TUI_VERSION="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(p.version||""))' "$TUI_PACKAGE_JSON")"
if [[ "$TUI_VERSION" != "$SUPPORTED_VERSION" ]]; then
  echo "Unsupported pi-tui version: $TUI_VERSION (expected $SUPPORTED_VERSION). Refusing to modify the installation." >&2
  exit 1
fi

TARGET="$TUI_ROOT/$TARGET_REL"
[[ -f "$TARGET" ]] || { echo "Missing editor target: $TARGET" >&2; exit 1; }
CURRENT_SHA256="$(sha256_file "$TARGET")"

if [[ "$CURRENT_SHA256" == "$PATCHED_SHA256" ]]; then
  echo "✓ History navigation patch is installed (pi $VERSION / pi-tui $TUI_VERSION)."
  exit 0
fi

if [[ "$CURRENT_SHA256" != "$STOCK_SHA256" ]]; then
  cat >&2 <<EOF
Unknown editor.js hash for pi $VERSION / pi-tui $TUI_VERSION.
  current:  $CURRENT_SHA256
  expected stock:   $STOCK_SHA256
  expected patched: $PATCHED_SHA256
Refusing to overwrite a modified or incompatible installation.
EOF
  exit 1
fi

if [[ "$MODE" == "check" ]]; then
  echo "History navigation patch is not installed; the official stock editor is present." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-history-navigation-apply.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_TARGET="$TMP_DIR/editor.js"
cp "$TARGET" "$TMP_TARGET"
patch --silent "$TMP_TARGET" "$PATCH_FILE"

RESULT_SHA256="$(sha256_file "$TMP_TARGET")"
if [[ "$RESULT_SHA256" != "$PATCHED_SHA256" ]]; then
  echo "Patched hash mismatch: $RESULT_SHA256" >&2
  exit 1
fi
node --check "$TMP_TARGET" >/dev/null
grep -q 'Once browsing history, arrows move between entries directly\.' "$TMP_TARGET"
grep -q 'this.historyIndex > -1' "$TMP_TARGET"

target_mode="$(stat -f '%Lp' "$TARGET" 2>/dev/null || stat -c '%a' "$TARGET")"
staged_target="$TARGET.tmp.$$"
cp "$TMP_TARGET" "$staged_target"
chmod "$target_mode" "$staged_target"
mv "$staged_target" "$TARGET"

FINAL_SHA256="$(sha256_file "$TARGET")"
[[ "$FINAL_SHA256" == "$PATCHED_SHA256" ]] || { echo "Final verification failed" >&2; exit 1; }
node --check "$TARGET" >/dev/null

echo "✓ Installed shell-like prompt history navigation for pi $VERSION / pi-tui $TUI_VERSION."
echo "  Restart pi to load the patched editor."
