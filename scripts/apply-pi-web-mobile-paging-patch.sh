#!/usr/bin/env bash
set -euo pipefail

readonly PACKAGE_NAME="@jmfederico/pi-web"
readonly SUPPORTED_VERSION="1.202608.1"
readonly STOCK_SHA256="a7686fe5e58b9091fcda0cce4f3f249bfa33fd7a2d070882b1f49aa5697c1210"
readonly PATCHED_SHA256="db3de7fd910e2a55e8e725fd034527816987a99ebab75b090fb8915f19077f7d"
readonly PATCH_ASSET_SHA256="b4c4322b0e3a6a2f70867b6c713c1a250eaa3731d1de01759622ec4d0c16efe5"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
readonly AGENT_DIR
readonly PATCH_FILE="$AGENT_DIR/patches/pi-web-mobile-paging/$SUPPORTED_VERSION/client-message-page-size.patch.json"
MODE="apply"

usage() {
  cat <<'EOF'
Usage: apply-pi-web-mobile-paging-patch.sh [--check|--restore]

Apply, verify, or restore the exact PI WEB 1.202608.1 client paging patch.
The patch changes the compiled MESSAGE_PAGE_SIZE from 100 to 20 without
modifying the server or session files. Set PI_WEB_PACKAGE_ROOT to operate on
a specific package fixture instead of the globally installed package.

  (no args)  Apply the patch; already-patched installations are accepted.
  --check    Succeed only when the patched client bundle is installed.
  --restore  Restore a known patched bundle to the exact official stock file.
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

if (( $# > 1 )); then
  usage >&2
  exit 2
fi
case "${1:-}" in
  "") ;;
  --check) MODE="check" ;;
  --restore) MODE="restore" ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac

for required_command in node mkdir mktemp chmod mv rm rmdir; do
  command -v "$required_command" >/dev/null 2>&1 || fail "Missing command: $required_command"
done
umask 077

# These hooks are intentionally limited to pre-commit failures and are used by
# the fixture test suite. There is no post-rename failure hook.
TEST_FAULT="${PI_WEB_MOBILE_PAGING_TEST_FAULT:-}"
readonly TEST_FAULT
case "$TEST_FAULT" in
  ""|pre-rename-hash|pre-rename-shape|pre-rename-node-check|rename) ;;
  *) fail "Unknown PI_WEB_MOBILE_PAGING_TEST_FAULT: $TEST_FAULT" ;;
esac

sha256_file() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const file = process.argv[2];
const hash = crypto.createHash("sha256");
hash.update(fs.readFileSync(file));
process.stdout.write(hash.digest("hex"));
NODE
}

file_mode() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const mode = fs.statSync(process.argv[2]).mode & 0o7777;
process.stdout.write(mode.toString(8));
NODE
}

file_identity() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const stat = fs.statSync(process.argv[2], { bigint: true });
process.stdout.write(`${stat.dev}:${stat.ino}`);
NODE
}

node_check_file() {
  # A secure mktemp name has a random final suffix, so ask Node to check the
  # staged bytes as an ES module on stdin rather than infer a type from suffix.
  node --check --input-type=module - < "$1"
}

lock_identity() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const stat = fs.lstatSync(process.argv[2], { bigint: true });
if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("lock is not a real directory");
process.stdout.write(`${stat.dev}:${stat.ino}`);
NODE
}

assert_empty_directory() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const entries = fs.readdirSync(process.argv[2]);
if (entries.length !== 0) throw new Error("lock directory must remain empty");
NODE
}

assert_safe_file() {
  local file="$1" description="$2"
  [[ -e "$file" || -L "$file" ]] || fail "Missing $description: $file"
  [[ ! -L "$file" ]] || fail "Refusing symlink $description: $file"
  [[ -f "$file" ]] || fail "$description is not a regular file: $file"
}

assert_safe_dir() {
  local dir="$1" description="$2"
  [[ -e "$dir" || -L "$dir" ]] || fail "Missing $description: $dir"
  [[ ! -L "$dir" ]] || fail "Refusing symlink $description: $dir"
  [[ -d "$dir" ]] || fail "$description is not a directory: $dir"
}

normalize_package_root_input() {
  node - "$1" <<'NODE'
const raw = process.argv[2];
const reject = (message) => {
  process.stderr.write(`Unsafe PI WEB package root: ${message}\n`);
  process.exit(1);
};
if (raw.length === 0) reject("empty path");
const absolute = raw.startsWith("/");
const parts = [];
for (const part of raw.split("/")) {
  if (part === "" || part === ".") continue;
  if (part === "..") reject("parent traversal is not allowed");
  parts.push(part);
}
let normalized = `${absolute ? "/" : ""}${parts.join("/")}`;
if (normalized === "") normalized = absolute ? "/" : ".";
process.stdout.write(normalized);
NODE
}

resolve_package_root() {
  local candidate normalized npm_root resolved
  if [[ -n "${PI_WEB_PACKAGE_ROOT:-}" ]]; then
    candidate="$PI_WEB_PACKAGE_ROOT"
  else
    command -v npm >/dev/null 2>&1 || fail "Missing command: npm"
    npm_root="$(npm root -g 2>/dev/null)" || fail "Cannot resolve the global npm package root"
    [[ -n "$npm_root" ]] || fail "npm root -g returned an empty path"
    candidate="$npm_root/$PACKAGE_NAME"
  fi

  [[ "$candidate" != *$'\n'* && "$candidate" != *$'\r'* ]] || fail "Package root contains a newline"
  normalized="$(normalize_package_root_input "$candidate")" || fail "Cannot safely normalize the PI WEB package root"
  # The lexical normalization removes trailing slash and '/.' aliases before
  # this lstat-style symlink check, so they cannot force directory following.
  assert_safe_dir "$normalized" "package root"
  resolved="$(cd "$normalized" && pwd -P)" || fail "Cannot resolve PI WEB package root: $normalized"
  [[ "$resolved" == /* ]] || fail "Resolved PI WEB package root is not absolute: $resolved"
  printf '%s\n' "$resolved"
}

assert_safe_file "$PATCH_FILE" "versioned patch asset"
[[ "$(sha256_file "$PATCH_FILE")" == "$PATCH_ASSET_SHA256" ]] || \
  fail "Versioned patch asset hash mismatch: $PATCH_FILE"

node - "$PATCH_FILE" "$PACKAGE_NAME" "$SUPPORTED_VERSION" "$STOCK_SHA256" "$PATCHED_SHA256" <<'NODE'
const fs = require("node:fs");
const [patchPath, packageName, version, stockSha256, patchedSha256] = process.argv.slice(2);
const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
const reject = (message) => { throw new Error(`Invalid patch asset: ${message}`); };
if (patch.format !== "pi-web-exact-client-replacement-v1") reject("format");
if (patch.package !== packageName || patch.version !== version) reject("package/version");
if (patch.upstream?.tag !== `v${version}`) reject("upstream tag");
if (patch.upstream?.commit !== "e3cd03aa18c9b677c45dc8f1992b3fe76816bafc") reject("upstream commit");
if (patch.upstream?.sourcePath !== "src/client/src/controllers/sessionController.ts") reject("source path");
if (patch.upstream?.sourceConstant !== "MESSAGE_PAGE_SIZE") reject("source constant");
if (patch.upstream?.stockValue !== 100 || patch.upstream?.patchedValue !== 20) reject("source values");
if (patch.bundle?.stockSha256 !== stockSha256 || patch.bundle?.patchedSha256 !== patchedSha256) reject("bundle hashes");
if (patch.bundle?.find !== "var $u=100,ed=class") reject("stock replacement context");
if (patch.bundle?.replace !== "var $u=20,ed=class") reject("patched replacement context");
if (patch.bundle?.expectedReplacementCount !== 1) reject("replacement count");
if (!Array.isArray(patch.bundle?.messageLimitUseContexts) || patch.bundle.messageLimitUseContexts.length !== 3) {
  reject("message call contexts");
}
NODE

PACKAGE_ROOT="$(resolve_package_root)"
readonly PACKAGE_ROOT
PACKAGE_JSON="$PACKAGE_ROOT/package.json"
DIST_DIR="$PACKAGE_ROOT/dist"
CLIENT_DIR="$DIST_DIR/client"
INDEX_HTML="$CLIENT_DIR/index.html"

# Every path component controlled below the canonical package root is checked
# without following a terminal symlink before it is read.
assert_safe_file "$PACKAGE_JSON" "package.json"
assert_safe_dir "$DIST_DIR" "dist directory"
assert_safe_dir "$CLIENT_DIR" "client directory"
assert_safe_file "$INDEX_HTML" "client index.html"

read_installed_version() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const [file, expectedName] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
if (pkg.name !== expectedName) throw new Error(`Unexpected package name: ${String(pkg.name)}`);
if (typeof pkg.version !== "string" || pkg.version.length === 0) throw new Error("Missing package version");
process.stdout.write(pkg.version);
NODE
}

INSTALLED_VERSION="$(read_installed_version "$PACKAGE_JSON" "$PACKAGE_NAME")" || \
  fail "Cannot validate package.json: $PACKAGE_JSON"

[[ "$INSTALLED_VERSION" == "$SUPPORTED_VERSION" ]] || \
  fail "Unsupported PI WEB version: $INSTALLED_VERSION (expected exactly $SUPPORTED_VERSION); installation was not modified"

resolve_main_asset() {
  node - "$1" "$2" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const [indexPath, clientRoot] = process.argv.slice(2);
const html = fs.readFileSync(indexPath, "utf8");
const openingTags = html.match(/<script\b[^>]*>/giu) ?? [];
const closingTags = html.match(/<\/script\s*>/giu) ?? [];
if (openingTags.length !== 1 || closingTags.length !== 1) {
  throw new Error(`Expected exactly one script element, found ${openingTags.length} opening and ${closingTags.length} closing tags`);
}
const opening = openingTags[0];
const openingAt = html.indexOf(opening);
const closingAt = html.search(/<\/script\s*>/iu);
if (closingAt < openingAt + opening.length || html.slice(openingAt + opening.length, closingAt).trim() !== "") {
  throw new Error("The main script element must not contain inline code");
}
const body = opening.slice("<script".length, -1);
const attributes = new Map();
const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|\x27([^\x27]*)\x27|([^\s"\x27=<>\x60]+)))?/gu;
let cursor = 0;
for (const match of body.matchAll(attributePattern)) {
  const gap = body.slice(cursor, match.index).trim();
  if (gap !== "" && gap !== "/") throw new Error("Malformed script attributes");
  const key = match[1].toLowerCase();
  if (attributes.has(key)) throw new Error(`Duplicate script attribute: ${key}`);
  attributes.set(key, match[2] ?? match[3] ?? match[4] ?? null);
  cursor = match.index + match[0].length;
}
const tail = body.slice(cursor).trim();
if (tail !== "" && tail !== "/") throw new Error("Malformed script tag tail");
if (attributes.get("type")?.toLowerCase() !== "module") throw new Error("Expected one module script");
const src = attributes.get("src");
if (typeof src !== "string" || src.length === 0) throw new Error("Module script src is missing");
if (/[\0\r\n\\%?#&]/u.test(src)) throw new Error("Unsafe module script path characters");
if (src.startsWith("/") || src.startsWith("//") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(src)) {
  throw new Error("Module script path must be package-relative");
}
const relative = src.startsWith("./") ? src.slice(2) : src;
if (relative.length === 0 || path.posix.normalize(relative) !== relative || relative === ".." || relative.startsWith("../")) {
  throw new Error("Module script path traversal is not allowed");
}
if (!relative.endsWith(".js")) throw new Error("Module script must be a JavaScript asset");
const resolved = path.resolve(clientRoot, relative);
const rootWithSeparator = path.resolve(clientRoot) + path.sep;
if (!resolved.startsWith(rootWithSeparator)) throw new Error("Module script escapes the client directory");
process.stdout.write(relative);
NODE
}

ASSET_REL="$(resolve_main_asset "$INDEX_HTML" "$CLIENT_DIR")" || \
  fail "Cannot safely resolve the main client asset from $INDEX_HTML"

[[ -n "$ASSET_REL" ]] || fail "Client index resolved an empty asset path"
IFS='/' read -r -a ASSET_COMPONENTS <<< "$ASSET_REL"
ASSET_PARENT="$CLIENT_DIR"
for (( i = 0; i < ${#ASSET_COMPONENTS[@]} - 1; i++ )); do
  ASSET_PARENT="$ASSET_PARENT/${ASSET_COMPONENTS[$i]}"
  assert_safe_dir "$ASSET_PARENT" "client asset directory"
done
TARGET="$CLIENT_DIR/$ASSET_REL"
assert_safe_file "$TARGET" "main client asset"
TARGET_PARENT_LEXICAL="${TARGET%/*}"
TARGET_BASE="${TARGET##*/}"
TARGET_DIR="$(cd "$TARGET_PARENT_LEXICAL" && pwd -P)"
[[ "$TARGET" == "$CLIENT_DIR/"* ]] || fail "Main client asset escapes the client directory"
[[ "$TARGET_DIR/$TARGET_BASE" == "$TARGET" ]] || fail "Main client asset resolves through an unsafe path"
readonly TARGET TARGET_DIR TARGET_BASE

validate_bundle_shape() {
  local file="$1" state="$2"
  node - "$file" "$state" "$PATCH_FILE" <<'NODE'
const fs = require("node:fs");
const [file, state, patchPath] = process.argv.slice(2);
const data = fs.readFileSync(file);
const content = data.toString("utf8");
if (!Buffer.from(content, "utf8").equals(data)) throw new Error("Client bundle is not valid UTF-8");
const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
const { find, replace, expectedReplacementCount, messageLimitUseContexts } = patch.bundle;
const occurrences = (haystack, needle) => {
  let count = 0;
  for (let at = 0; (at = haystack.indexOf(needle, at)) !== -1; at += needle.length) count++;
  return count;
};
const declaration = find.match(/^var ([A-Za-z_$][A-Za-z0-9_$]*)=(\d+),(.+)$/u);
if (!declaration) throw new Error("Patch declaration context is malformed");
const [, symbol, stockValue, suffix] = declaration;
if (replace !== `var ${symbol}=${String(patch.upstream.patchedValue)},${suffix}` || Number(stockValue) !== patch.upstream.stockValue) {
  throw new Error("Patch declaration contexts do not map to the source constant");
}
const expectedFind = state === "stock" ? expectedReplacementCount : 0;
const expectedReplace = state === "patched" ? expectedReplacementCount : 0;
if (occurrences(content, find) !== expectedFind || occurrences(content, replace) !== expectedReplace) {
  throw new Error(`Unexpected ${state} declaration count`);
}
for (const context of messageLimitUseContexts) {
  if (!context.includes(`limit:${symbol}`) || occurrences(content, context) !== 1) {
    throw new Error(`Missing unique MESSAGE_PAGE_SIZE use context: ${context}`);
  }
}
if (occurrences(content, `limit:${symbol}`) !== messageLimitUseContexts.length) {
  throw new Error("Unexpected MESSAGE_PAGE_SIZE limit use count");
}
const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
const symbolMatches = content.match(new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "gu")) ?? [];
if (symbolMatches.length !== messageLimitUseContexts.length + 1) {
  throw new Error("Unexpected compiled MESSAGE_PAGE_SIZE symbol references");
}
NODE
}

LOCK_DIR="$TARGET_DIR/.pi-web-mobile-paging.lock"
LOCK_HELD=false
LOCK_IDENTITY=""
STAGED_TARGET=""

cleanup_owned_artifacts() {
  local current_lock_identity=""
  if [[ -n "$STAGED_TARGET" ]]; then
    rm -f "$STAGED_TARGET" >/dev/null 2>&1 || :
    STAGED_TARGET=""
  fi
  if [[ "$LOCK_HELD" == true ]]; then
    current_lock_identity="$(lock_identity "$LOCK_DIR" 2>/dev/null || :)"
    if [[ -n "$current_lock_identity" && "$current_lock_identity" == "$LOCK_IDENTITY" ]]; then
      rmdir "$LOCK_DIR" >/dev/null 2>&1 || :
    fi
    LOCK_HELD=false
    LOCK_IDENTITY=""
  fi
  return 0
}

acquire_lock() {
  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    if [[ -e "$LOCK_DIR" || -L "$LOCK_DIR" ]]; then
      fail "Exclusive mobile paging lock exists: $LOCK_DIR. Refusing concurrent apply/restore; if no patch process is running, inspect and remove this stale lock directory manually."
    fi
    fail "Cannot create exclusive mobile paging lock in $TARGET_DIR; verify package permissions"
  fi
  LOCK_HELD=true
  LOCK_IDENTITY="$(lock_identity "$LOCK_DIR")" || fail "Cannot validate the newly created paging lock"
  [[ "$(file_mode "$LOCK_DIR")" == "700" ]] || fail "Paging lock mode is not 0700: $LOCK_DIR"
  assert_empty_directory "$LOCK_DIR" || fail "Paging lock is not empty: $LOCK_DIR"
}

assert_owned_lock() {
  local current_lock_identity
  current_lock_identity="$(lock_identity "$LOCK_DIR")" || fail "Exclusive paging lock disappeared before installation"
  [[ "$current_lock_identity" == "$LOCK_IDENTITY" ]] || fail "Exclusive paging lock ownership changed before installation"
  [[ "$(file_mode "$LOCK_DIR")" == "700" ]] || fail "Exclusive paging lock mode changed before installation"
  assert_empty_directory "$LOCK_DIR" || fail "Exclusive paging lock gained unexpected contents"
}

if [[ "$MODE" != "check" ]]; then
  trap cleanup_owned_artifacts EXIT
  # Do not allow a catchable signal between successful mkdir and recording
  # ownership; otherwise EXIT cleanup could not safely identify our lock.
  trap '' HUP INT TERM
  acquire_lock
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
fi

# Apply and restore hold the exclusive lock before this first bundle hash read
# until the atomic rename has completed. Check mode is intentionally read-only.
assert_safe_file "$TARGET" "main client asset"
CURRENT_SHA256="$(sha256_file "$TARGET")"
case "$CURRENT_SHA256" in
  "$STOCK_SHA256") CURRENT_STATE="stock" ;;
  "$PATCHED_SHA256") CURRENT_STATE="patched" ;;
  *)
    cat >&2 <<EOF
Unknown PI WEB client bundle hash for $SUPPORTED_VERSION.
  asset:    $ASSET_REL
  current:  $CURRENT_SHA256
  stock:    $STOCK_SHA256
  patched:  $PATCHED_SHA256
Refusing to overwrite a tampered or incompatible installation.
EOF
    exit 1
    ;;
esac

if [[ "$MODE" == "check" ]]; then
  validate_bundle_shape "$TARGET" "$CURRENT_STATE"
  node_check_file "$TARGET" >/dev/null
  if [[ "$CURRENT_STATE" != "patched" ]]; then
    echo "PI WEB mobile paging patch is not installed; the exact official stock bundle is present." >&2
    exit 1
  fi
  echo "✓ PI WEB $SUPPORTED_VERSION mobile paging patch is installed (MESSAGE_PAGE_SIZE=20)."
  exit 0
fi

if [[ "$MODE" == "apply" && "$CURRENT_STATE" == "patched" ]]; then
  validate_bundle_shape "$TARGET" "patched"
  node_check_file "$TARGET" >/dev/null
  cleanup_owned_artifacts
  trap - EXIT HUP INT TERM
  echo "✓ PI WEB $SUPPORTED_VERSION mobile paging patch is already installed (MESSAGE_PAGE_SIZE=20)."
  exit 0
fi
if [[ "$MODE" == "restore" && "$CURRENT_STATE" == "stock" ]]; then
  validate_bundle_shape "$TARGET" "stock"
  node_check_file "$TARGET" >/dev/null
  cleanup_owned_artifacts
  trap - EXIT HUP INT TERM
  echo "✓ PI WEB $SUPPORTED_VERSION client bundle is already restored to official stock (MESSAGE_PAGE_SIZE=100)."
  exit 0
fi

if [[ "$MODE" == "apply" ]]; then
  FROM_STATE="stock"
  TO_STATE="patched"
  EXPECTED_RESULT_SHA256="$PATCHED_SHA256"
  DIRECTION="apply"
  SUCCESS_MESSAGE="✓ Installed PI WEB $SUPPORTED_VERSION mobile paging patch (MESSAGE_PAGE_SIZE=20)."
else
  FROM_STATE="patched"
  TO_STATE="stock"
  EXPECTED_RESULT_SHA256="$STOCK_SHA256"
  DIRECTION="restore"
  SUCCESS_MESSAGE="✓ Restored the exact official PI WEB $SUPPORTED_VERSION client bundle (MESSAGE_PAGE_SIZE=100)."
fi
[[ "$CURRENT_STATE" == "$FROM_STATE" ]] || fail "Internal state transition error"

TARGET_MODE="$(file_mode "$TARGET")"
TARGET_IDENTITY="$(file_identity "$TARGET")"

# The only write candidate is a securely-created private file beside TARGET,
# which guarantees that the final rename cannot cross filesystems.
STAGED_TARGET="$(mktemp "$TARGET_DIR/.${TARGET_BASE}.pi-web-mobile-paging.stage.XXXXXX")"
[[ ! -L "$STAGED_TARGET" && -f "$STAGED_TARGET" ]] || fail "Could not create a safe staged client bundle"
[[ "$(file_mode "$STAGED_TARGET")" == "600" ]] || fail "Private staged client bundle mode is not 0600"

node - "$TARGET" "$STAGED_TARGET" <<'NODE'
const fs = require("node:fs");
const [source, destination] = process.argv.slice(2);
fs.writeFileSync(destination, fs.readFileSync(source), { flag: "w" });
NODE

# Validate the exact source bytes and syntax on the staged inode, not on a file
# that has already been installed.
[[ "$(sha256_file "$STAGED_TARGET")" == "$CURRENT_SHA256" ]] || fail "Staged source bundle hash mismatch"
validate_bundle_shape "$STAGED_TARGET" "$FROM_STATE"
node_check_file "$STAGED_TARGET" >/dev/null

node - "$STAGED_TARGET" "$PATCH_FILE" "$DIRECTION" <<'NODE'
const fs = require("node:fs");
const [file, patchPath, direction] = process.argv.slice(2);
const patch = JSON.parse(fs.readFileSync(patchPath, "utf8"));
const from = direction === "apply" ? patch.bundle.find : patch.bundle.replace;
const to = direction === "apply" ? patch.bundle.replace : patch.bundle.find;
const data = fs.readFileSync(file);
const content = data.toString("utf8");
if (!Buffer.from(content, "utf8").equals(data)) throw new Error("Client bundle is not valid UTF-8");
const count = content.split(from).length - 1;
const oppositeCount = content.split(to).length - 1;
if (count !== patch.bundle.expectedReplacementCount || oppositeCount !== 0) {
  throw new Error(`Expected one exact ${direction} context; found ${count} source and ${oppositeCount} destination contexts`);
}
const result = content.replace(from, to);
if (result.split(to).length - 1 !== patch.bundle.expectedReplacementCount || result.split(from).length - 1 !== 0) {
  throw new Error(`Exact ${direction} replacement count verification failed`);
}
fs.writeFileSync(file, result, { encoding: "utf8", flag: "w" });
NODE

chmod "$TARGET_MODE" "$STAGED_TARGET"
node - "$STAGED_TARGET" <<'NODE'
const fs = require("node:fs");
const fd = fs.openSync(process.argv[2], "r");
try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
NODE

# These are the final result checks. Fault injection can only make one of these
# pre-rename checks (or the rename itself) fail while TARGET remains untouched.
FINAL_SHA256="$(sha256_file "$STAGED_TARGET")"
if [[ "$TEST_FAULT" == "pre-rename-hash" ]]; then
  FINAL_SHA256="injected-hash-check-failure"
fi
[[ "$FINAL_SHA256" == "$EXPECTED_RESULT_SHA256" ]] || fail "Final staged client bundle hash verification failed"

FINAL_SHAPE_STATE="$TO_STATE"
if [[ "$TEST_FAULT" == "pre-rename-shape" ]]; then
  FINAL_SHAPE_STATE="$FROM_STATE"
fi
validate_bundle_shape "$STAGED_TARGET" "$FINAL_SHAPE_STATE"

if [[ "$TEST_FAULT" == "pre-rename-node-check" ]]; then
  fail "Injected final staged node --check failure"
fi
node_check_file "$STAGED_TARGET" >/dev/null
[[ "$(file_mode "$STAGED_TARGET")" == "$TARGET_MODE" ]] || fail "Final staged client bundle mode verification failed"

# A non-cooperating writer is still detected immediately before commit. Every
# check remains before rename, and a failure removes only our stage and lock.
assert_safe_file "$TARGET" "main client asset"
[[ "$(file_identity "$TARGET")" == "$TARGET_IDENTITY" ]] || fail "Client bundle inode changed before atomic installation"
[[ "$(sha256_file "$TARGET")" == "$CURRENT_SHA256" ]] || fail "Client bundle changed before atomic installation"
[[ "$(file_mode "$TARGET")" == "$TARGET_MODE" ]] || fail "Client bundle mode changed before atomic installation"
assert_owned_lock

RENAME_SOURCE="$STAGED_TARGET"
if [[ "$TEST_FAULT" == "rename" ]]; then
  # Point the real mv invocation through the regular staged file as though it
  # were a directory, guaranteeing ENOTDIR while retaining it for EXIT cleanup.
  RENAME_SOURCE="$STAGED_TARGET/injected-missing"
fi

# Ignore catchable termination signals across the single commit syscall. The
# same-directory atomic rename is the final operation whose status can fail.
trap '' HUP INT TERM
if ! mv -f "$RENAME_SOURCE" "$TARGET"; then
  fail "Atomic client bundle rename failed; installation was not modified"
fi

# Commit succeeded. From here cleanup and reporting are explicitly non-failing;
# there is no validation, rollback, or failure hook after the rename.
STAGED_TARGET=""
cleanup_owned_artifacts
trap - EXIT || :
printf '%s\n' "$SUCCESS_MESSAGE" || :
printf '%s\n' "  No service restart is required; hard-refresh open browsers." || :
exit 0
