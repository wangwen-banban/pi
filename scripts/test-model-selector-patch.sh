#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY_SCRIPT="$SCRIPT_DIR/apply-model-selector-patch.sh"
VERSION="0.84.1"
PATCHED_SHA256="1bd77132936732a24598f6832ac436e1f274fb47fe89ced04e94481baac3c024"
TARGET_REL="dist/modes/interactive/components/model-selector.js"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-model-selector-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

cd "$TMP_DIR"
TARBALL="$(npm pack "@earendil-works/pi-coding-agent@$VERSION" --silent)"
tar -xzf "$TARBALL"
PACKAGE_ROOT="$TMP_DIR/package"
TARGET="$PACKAGE_ROOT/$TARGET_REL"

STOCK_BEFORE="$(sha256_file "$TARGET")"
if PI_PACKAGE_ROOT="$PACKAGE_ROOT" "$APPLY_SCRIPT" --check >/dev/null 2>&1; then
  echo "Expected --check to reject the official stock file" >&2
  exit 1
fi
[[ "$(sha256_file "$TARGET")" == "$STOCK_BEFORE" ]]
echo "✓ --check detects the unpatched official package without modifying it"

PI_PACKAGE_ROOT="$PACKAGE_ROOT" "$APPLY_SCRIPT" >/dev/null
[[ "$(sha256_file "$TARGET")" == "$PATCHED_SHA256" ]]
node --check "$TARGET" >/dev/null
grep -q 'expandedProviders = new Set()' "$TARGET"
grep -q 'rows.push({ type: "provider"' "$TARGET"
grep -q 'rows.push({ type: "model"' "$TARGET"
grep -q 'toggleProvider' "$TARGET"
grep -q 'matchesKey(keyData, Key.right)' "$TARGET"
grep -q 'matchesKey(keyData, Key.left)' "$TARGET"
echo "✓ official $VERSION package patches to the exact expected two-level selector"

PI_PACKAGE_ROOT="$PACKAGE_ROOT" "$APPLY_SCRIPT" --check >/dev/null
PI_PACKAGE_ROOT="$PACKAGE_ROOT" "$APPLY_SCRIPT" >/dev/null
[[ "$(sha256_file "$TARGET")" == "$PATCHED_SHA256" ]]
echo "✓ check/apply are idempotent after installation"

printf '\n// incompatible local edit\n' >> "$TARGET"
UNKNOWN_BEFORE="$(sha256_file "$TARGET")"
if PI_PACKAGE_ROOT="$PACKAGE_ROOT" "$APPLY_SCRIPT" >/dev/null 2>&1; then
  echo "Expected apply to reject an unknown target hash" >&2
  exit 1
fi
[[ "$(sha256_file "$TARGET")" == "$UNKNOWN_BEFORE" ]]
echo "✓ unknown/incompatible target hashes are rejected without overwrite"
