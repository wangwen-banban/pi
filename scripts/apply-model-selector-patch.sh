#!/usr/bin/env bash
set -euo pipefail

SUPPORTED_VERSION="0.84.1"
STOCK_SHA256="de37a0e7abfe2650720bdc7098b3fe1468674593c148f4571d6d897420cc4d01"
PATCHED_SHA256="1bd77132936732a24598f6832ac436e1f274fb47fe89ced04e94481baac3c024"
TARGET_REL="dist/modes/interactive/components/model-selector.js"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCH_FILE="$AGENT_DIR/patches/pi-model-selector/$SUPPORTED_VERSION/model-selector.patch"
MODE="apply"

usage() {
  cat <<'EOF'
Usage: apply-model-selector-patch.sh [--check]

Apply or verify the provider-first, model-second selector patch for the
supported global pi package version. Set PI_PACKAGE_ROOT to test or patch a
specific package directory.
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

PACKAGE_ROOT="$(resolve_package_root)"
PACKAGE_JSON="$PACKAGE_ROOT/package.json"
TARGET="$PACKAGE_ROOT/$TARGET_REL"

[[ -f "$PATCH_FILE" ]] || { echo "Missing patch: $PATCH_FILE" >&2; exit 1; }
[[ -f "$PACKAGE_JSON" ]] || { echo "Missing package.json: $PACKAGE_JSON" >&2; exit 1; }
[[ -f "$TARGET" ]] || { echo "Missing model selector: $TARGET" >&2; exit 1; }

VERSION="$(node -e 'const p=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(p.version||""))' "$PACKAGE_JSON")"
CURRENT_SHA256="$(sha256_file "$TARGET")"

if [[ "$VERSION" != "$SUPPORTED_VERSION" ]]; then
  echo "Unsupported pi version: $VERSION (expected $SUPPORTED_VERSION). Refusing to modify $TARGET" >&2
  exit 1
fi

if [[ "$CURRENT_SHA256" == "$PATCHED_SHA256" ]]; then
  echo "✓ Two-level model selector is installed ($VERSION)."
  exit 0
fi

if [[ "$CURRENT_SHA256" != "$STOCK_SHA256" ]]; then
  cat >&2 <<EOF
Unknown model-selector.js hash for pi $VERSION.
  current:  $CURRENT_SHA256
  expected stock:   $STOCK_SHA256
  expected patched: $PATCHED_SHA256
Refusing to overwrite a modified or incompatible installation.
EOF
  exit 1
fi

if [[ "$MODE" == "check" ]]; then
  echo "Two-level model selector is not installed; the official stock file is present." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-model-selector-apply.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_TARGET="$TMP_DIR/model-selector.mjs"
cp "$TARGET" "$TMP_TARGET"
patch --silent "$TMP_TARGET" "$PATCH_FILE"

RESULT_SHA256="$(sha256_file "$TMP_TARGET")"
if [[ "$RESULT_SHA256" != "$PATCHED_SHA256" ]]; then
  echo "Patched hash mismatch: $RESULT_SHA256" >&2
  exit 1
fi
node --check "$TMP_TARGET" >/dev/null

grep -q 'expandedProviders = new Set()' "$TMP_TARGET"
grep -q 'type === "provider"' "$TMP_TARGET"
grep -q 'toggleProvider' "$TMP_TARGET"

TARGET_MODE="$(stat -f '%Lp' "$TARGET" 2>/dev/null || stat -c '%a' "$TARGET")"
STAGED_TARGET="$TARGET.tmp.$$"
cp "$TMP_TARGET" "$STAGED_TARGET"
chmod "$TARGET_MODE" "$STAGED_TARGET"
mv "$STAGED_TARGET" "$TARGET"

FINAL_SHA256="$(sha256_file "$TARGET")"
[[ "$FINAL_SHA256" == "$PATCHED_SHA256" ]] || { echo "Final verification failed" >&2; exit 1; }

echo "✓ Installed provider-first, model-second selector for pi $VERSION."
echo "  Restart pi to load the patched component."
