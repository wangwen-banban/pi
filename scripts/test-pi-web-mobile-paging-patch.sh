#!/usr/bin/env bash
# Self-contained tests for the version-gated PI WEB client paging patch.
# Every mutable package and setup fixture lives under /tmp; the installed
# package, when used as a stock source, is read-only to this test.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
readonly SCRIPT_DIR
AGENT_DIR="$(cd "$SCRIPT_DIR/.." && pwd -P)"
readonly AGENT_DIR
readonly APPLY_SCRIPT="$SCRIPT_DIR/apply-pi-web-mobile-paging-patch.sh"
readonly SETUP_SCRIPT="$SCRIPT_DIR/setup-pi-web.sh"
readonly PATCH_ASSET="$AGENT_DIR/patches/pi-web-mobile-paging/1.202608.1/client-message-page-size.patch.json"
readonly VERSION="1.202608.1"
readonly STOCK_SHA256="a7686fe5e58b9091fcda0cce4f3f249bfa33fd7a2d070882b1f49aa5697c1210"
readonly PATCHED_SHA256="db3de7fd910e2a55e8e725fd034527816987a99ebab75b090fb8915f19077f7d"
readonly TARGET_REL="dist/client/assets/index-uI2AGFUy.js"
TMP_ROOT="$(mktemp -d /tmp/pi-web-mobile-paging-test.XXXXXX)"
readonly TMP_ROOT
SOCKET_PID=""
TEST_COUNT=0

cleanup() {
  if [[ -n "$SOCKET_PID" ]]; then
    kill "$SOCKET_PID" >/dev/null 2>&1 || true
    wait "$SOCKET_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

pass() {
  TEST_COUNT=$((TEST_COUNT + 1))
  echo "  ✓ $*"
}

sha256_file() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[2])).digest("hex"));
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

file_size() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
process.stdout.write(String(fs.statSync(process.argv[2]).size));
NODE
}

assert_no_patch_artifacts() {
  local root="$1"
  if find "$root" \( -name '.pi-web-mobile-paging.lock' -o -name '*.pi-web-mobile-paging.stage.*' -o -name '*.orig' -o -name '*.rej' -o -name '*~' \) -print -quit | grep -q .; then
    fail "paging lock, staged file, or backup artifact remains under $root"
  fi
}

expect_patch_failure() {
  local root="$1"
  shift
  mkdir -p "$TMP_ROOT/command-tmp"
  if PI_WEB_PACKAGE_ROOT="$root" TMPDIR="$TMP_ROOT/command-tmp" "$APPLY_SCRIPT" "$@" >/dev/null 2>&1; then
    fail "patch command unexpectedly succeeded for $root ${*:-apply}"
  fi
}

expect_fault_failure() {
  local root="$1" fault="$2"
  shift 2
  mkdir -p "$TMP_ROOT/command-tmp"
  if PI_WEB_PACKAGE_ROOT="$root" \
      PI_WEB_MOBILE_PAGING_TEST_FAULT="$fault" \
      TMPDIR="$TMP_ROOT/command-tmp" \
      "$APPLY_SCRIPT" "$@" >/dev/null 2>&1; then
    fail "fault $fault unexpectedly succeeded for $root ${*:-apply}"
  fi
}

run_patch() {
  local root="$1"
  shift
  mkdir -p "$TMP_ROOT/command-tmp"
  PI_WEB_PACKAGE_ROOT="$root" TMPDIR="$TMP_ROOT/command-tmp" "$APPLY_SCRIPT" "$@" >/dev/null
}

find_stock_source() {
  local candidate="${PI_WEB_STOCK_PACKAGE_ROOT:-}" npm_root pack_dir tarball
  if [[ -z "$candidate" ]] && command -v npm >/dev/null 2>&1; then
    npm_root="$(npm root -g 2>/dev/null || true)"
    candidate="$npm_root/@jmfederico/pi-web"
  fi
  if [[ -f "$candidate/package.json" && -f "$candidate/$TARGET_REL" ]] && \
     [[ "$(sha256_file "$candidate/$TARGET_REL")" == "$STOCK_SHA256" ]]; then
    printf '%s\n' "$candidate"
    return
  fi

  command -v npm >/dev/null 2>&1 || fail "npm is required to obtain the official stock test fixture"
  pack_dir="$TMP_ROOT/npm-pack"
  mkdir -p "$pack_dir"
  tarball="$(cd "$pack_dir" && npm pack "@jmfederico/pi-web@$VERSION" --silent)"
  tar -xzf "$pack_dir/$tarball" -C "$pack_dir"
  candidate="$pack_dir/package"
  [[ -f "$candidate/$TARGET_REL" ]] || fail "npm package is missing $TARGET_REL"
  [[ "$(sha256_file "$candidate/$TARGET_REL")" == "$STOCK_SHA256" ]] || fail "official npm fixture stock hash mismatch"
  printf '%s\n' "$candidate"
}

STOCK_SOURCE="$(find_stock_source)"
readonly STOCK_SOURCE
SOURCE_HASH_BEFORE="$(sha256_file "$STOCK_SOURCE/$TARGET_REL")"
readonly SOURCE_HASH_BEFORE

make_fixture() {
  local root="$TMP_ROOT/$1"
  mkdir -p "$root/dist/client/assets" "$root/test-tmp"
  cp "$STOCK_SOURCE/package.json" "$root/package.json"
  cp "$STOCK_SOURCE/dist/client/index.html" "$root/dist/client/index.html"
  cp "$STOCK_SOURCE/$TARGET_REL" "$root/$TARGET_REL"
  printf '%s\n' "$root"
}

echo "PI WEB mobile paging patch tests"

node - "$PATCH_ASSET" "$STOCK_SOURCE/$TARGET_REL" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [assetPath, stockPath] = process.argv.slice(2);
const patch = JSON.parse(fs.readFileSync(assetPath, "utf8"));
const stock = fs.readFileSync(stockPath, "utf8");
assert.equal(patch.upstream.tag, "v1.202608.1");
assert.equal(patch.upstream.commit, "e3cd03aa18c9b677c45dc8f1992b3fe76816bafc");
assert.equal(patch.upstream.sourcePath, "src/client/src/controllers/sessionController.ts");
assert.equal(patch.upstream.sourceConstant, "MESSAGE_PAGE_SIZE");
assert.equal(patch.upstream.stockValue, 100);
assert.equal(patch.upstream.patchedValue, 20);
assert.equal(stock.split(patch.bundle.find).length - 1, 1);
assert.equal(patch.bundle.messageLimitUseContexts.length, 3);
for (const context of patch.bundle.messageLimitUseContexts) assert.equal(stock.split(context).length - 1, 1);
NODE
pass "tag source maps MESSAGE_PAGE_SIZE and its three calls to one compiled symbol"

stock_fixture="$(make_fixture stock-check)"
stock_target="$stock_fixture/$TARGET_REL"
stock_before="$(sha256_file "$stock_target")"
stock_identity="$(file_identity "$stock_target")"
expect_patch_failure "$stock_fixture" --check
[[ "$(sha256_file "$stock_target")" == "$stock_before" ]] || fail "stock --check modified the bundle"
[[ "$(file_identity "$stock_target")" == "$stock_identity" ]] || fail "stock --check replaced the bundle"
pass "--check rejects stock without modifying it"

chmod 751 "$stock_target"
identity_before_apply="$(file_identity "$stock_target")"
run_patch "$stock_fixture"
[[ "$(sha256_file "$stock_target")" == "$PATCHED_SHA256" ]] || fail "apply did not produce the expected patched hash"
[[ "$(file_mode "$stock_target")" == "751" ]] || fail "apply did not preserve mode"
[[ "$(file_identity "$stock_target")" != "$identity_before_apply" ]] || fail "apply did not atomically replace the inode"
node --check "$stock_target" >/dev/null
[[ -z "$(find "$stock_fixture/test-tmp" -mindepth 1 -print -quit)" ]] || fail "private apply temp files remain"
[[ -z "$(find "$(dirname "$stock_target")" -maxdepth 1 \( -name '*.pi-web-mobile-paging.*' -o -name '*.orig' -o -name '*.rej' -o -name '*~' \) -print -quit)" ]] || fail "staged or backup files remain"
pass "apply has exact patched hash, preserves mode, atomically renames, and leaves no temp/backup"

node - "$STOCK_SOURCE/$TARGET_REL" "$stock_target" "$PATCH_ASSET" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");
const [stockPath, patchedPath, assetPath] = process.argv.slice(2);
const stock = fs.readFileSync(stockPath, "utf8");
const patched = fs.readFileSync(patchedPath, "utf8");
const spec = JSON.parse(fs.readFileSync(assetPath, "utf8"));
assert.equal(stock.split(spec.bundle.find).length - 1, 1);
assert.equal(patched, stock.replace(spec.bundle.find, spec.bundle.replace));
assert.equal(patched.replace(spec.bundle.replace, spec.bundle.find), stock);
const declaration = spec.bundle.replace.match(/^var ([A-Za-z_$][A-Za-z0-9_$]*)=20,/u);
assert.ok(declaration);
const symbol = declaration[1];
assert.equal(patched.split(`limit:${symbol}`).length - 1, 3);
for (const context of spec.bundle.messageLimitUseContexts) assert.equal(patched.split(context).length - 1, 1);
const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
assert.equal((patched.match(new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`, "gu")) ?? []).length, 4);
NODE
pass "all three messages calls resolve to limit 20 and every other 100 byte is unchanged"

patched_identity="$(file_identity "$stock_target")"
run_patch "$stock_fixture" --check
run_patch "$stock_fixture"
[[ "$(sha256_file "$stock_target")" == "$PATCHED_SHA256" ]] || fail "idempotent apply changed hash"
[[ "$(file_identity "$stock_target")" == "$patched_identity" ]] || fail "idempotent apply unnecessarily replaced the file"
pass "patched --check and repeated apply are idempotent"

identity_before_restore="$(file_identity "$stock_target")"
run_patch "$stock_fixture" --restore
[[ "$(sha256_file "$stock_target")" == "$STOCK_SHA256" ]] || fail "restore did not reproduce stock hash"
[[ "$(file_mode "$stock_target")" == "751" ]] || fail "restore did not preserve mode"
[[ "$(file_identity "$stock_target")" != "$identity_before_restore" ]] || fail "restore did not atomically replace the inode"
restored_identity="$(file_identity "$stock_target")"
run_patch "$stock_fixture" --restore
[[ "$(file_identity "$stock_target")" == "$restored_identity" ]] || fail "idempotent restore replaced stock"
expect_patch_failure "$stock_fixture" --check
pass "--restore exactly and idempotently returns patched content to stock"

tampered_fixture="$(make_fixture tampered)"
tampered_target="$tampered_fixture/$TARGET_REL"
printf '\n// local tamper\n' >> "$tampered_target"
for option in apply --check --restore; do
  tampered_before="$(sha256_file "$tampered_target")"
  if [[ "$option" == "apply" ]]; then
    expect_patch_failure "$tampered_fixture"
  else
    expect_patch_failure "$tampered_fixture" "$option"
  fi
  [[ "$(sha256_file "$tampered_target")" == "$tampered_before" ]] || fail "tampered $option was overwritten"
done
pass "apply/check/restore reject an unknown bundle hash without overwrite"

wrong_fixture="$(make_fixture wrong-version)"
node - "$wrong_fixture/package.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = "1.202608.2";
fs.writeFileSync(file, `${JSON.stringify(pkg)}\n`);
NODE
wrong_before="$(sha256_file "$wrong_fixture/$TARGET_REL")"
expect_patch_failure "$wrong_fixture"
expect_patch_failure "$wrong_fixture" --check
expect_patch_failure "$wrong_fixture" --restore
[[ "$(sha256_file "$wrong_fixture/$TARGET_REL")" == "$wrong_before" ]] || fail "wrong-version bundle was modified"
pass "all modes reject non-1.202608.1 packages"

symlink_fixture="$(make_fixture target-symlink)"
symlink_target="$symlink_fixture/$TARGET_REL"
external_target="$TMP_ROOT/symlink-external.js"
mv "$symlink_target" "$external_target"
external_before="$(sha256_file "$external_target")"
ln -s "$external_target" "$symlink_target"
expect_patch_failure "$symlink_fixture"
expect_patch_failure "$symlink_fixture" --check
expect_patch_failure "$symlink_fixture" --restore
[[ -L "$symlink_target" ]] || fail "target symlink was replaced"
[[ "$(sha256_file "$external_target")" == "$external_before" ]] || fail "target symlink destination was modified"
pass "all modes reject target symlinks without following them"

traversal_fixture="$(make_fixture path-traversal)"
traversal_outside="$traversal_fixture/dist/outside.js"
cp "$traversal_fixture/$TARGET_REL" "$traversal_outside"
node - "$traversal_fixture/dist/client/index.html" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, html.replace("./assets/index-uI2AGFUy.js", "../outside.js"));
NODE
traversal_before="$(sha256_file "$traversal_outside")"
expect_patch_failure "$traversal_fixture"
[[ "$(sha256_file "$traversal_outside")" == "$traversal_before" ]] || fail "path traversal destination was modified"
pass "index.html path traversal is rejected before reading or writing its destination"

multiple_fixture="$(make_fixture multiple-scripts)"
node - "$multiple_fixture/dist/client/index.html" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, html.replace("</head>", "<script type=\"module\" src=\"./assets/extra.js\"></script></head>"));
NODE
multiple_before="$(sha256_file "$multiple_fixture/$TARGET_REL")"
expect_patch_failure "$multiple_fixture"
[[ "$(sha256_file "$multiple_fixture/$TARGET_REL")" == "$multiple_before" ]] || fail "multiple-script fixture was modified"
pass "index.html with multiple script elements is rejected"

dynamic_fixture="$(make_fixture dynamic-asset)"
mv "$dynamic_fixture/$TARGET_REL" "$dynamic_fixture/dist/client/assets/revision-renamed.js"
node - "$dynamic_fixture/dist/client/index.html" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const html = fs.readFileSync(file, "utf8");
fs.writeFileSync(file, html.replace("./assets/index-uI2AGFUy.js", "./assets/revision-renamed.js"));
NODE
run_patch "$dynamic_fixture"
[[ "$(sha256_file "$dynamic_fixture/dist/client/assets/revision-renamed.js")" == "$PATCHED_SHA256" ]] || fail "dynamically resolved asset was not patched"
[[ ! -e "$dynamic_fixture/$TARGET_REL" ]] || fail "hard-coded asset path was recreated"
pass "actual main asset is resolved from index.html rather than a hard-coded filename"

root_symlink_fixture="$(make_fixture package-root-real)"
root_symlink="$TMP_ROOT/package-root-link"
ln -s "$root_symlink_fixture" "$root_symlink"
root_symlink_spellings=(
  "$root_symlink"
  "$root_symlink/"
  "$root_symlink/."
  "${TMP_ROOT}//package-root-link//."
)
for spelling in "${root_symlink_spellings[@]}"; do
  expect_patch_failure "$spelling"
  expect_patch_failure "$spelling" --check
  expect_patch_failure "$spelling" --restore
done
[[ "$(sha256_file "$root_symlink_fixture/$TARGET_REL")" == "$STOCK_SHA256" ]] || fail "symlink package root modified its target"
pass "all modes lexically normalize and reject package-root symlinks, including trailing /, repeated /, and /. aliases"

normalized_fixture="$(make_fixture normalized-root)"
run_patch "${normalized_fixture}//./"
[[ "$(sha256_file "$normalized_fixture/$TARGET_REL")" == "$PATCHED_SHA256" ]] || fail "normalized real package root was not patched"
run_patch "${normalized_fixture}///." --restore
[[ "$(sha256_file "$normalized_fixture/$TARGET_REL")" == "$STOCK_SHA256" ]] || fail "normalized real package root was not restored"
pass "harmless repeated-slash and trailing-dot spellings of a real package root remain supported"

index_symlink_fixture="$(make_fixture index-symlink)"
index_external="$TMP_ROOT/index-symlink-external.html"
mv "$index_symlink_fixture/dist/client/index.html" "$index_external"
ln -s "$index_external" "$index_symlink_fixture/dist/client/index.html"
index_symlink_target="$index_symlink_fixture/$TARGET_REL"
index_symlink_before="$(sha256_file "$index_symlink_target")"
for option in apply --check --restore; do
  if [[ "$option" == "apply" ]]; then
    expect_patch_failure "$index_symlink_fixture"
  else
    expect_patch_failure "$index_symlink_fixture" "$option"
  fi
done
[[ -L "$index_symlink_fixture/dist/client/index.html" ]] || fail "index.html symlink was replaced"
[[ "$(sha256_file "$index_symlink_target")" == "$index_symlink_before" ]] || fail "index.html symlink probe modified the asset"

asset_dir_symlink_fixture="$(make_fixture asset-dir-symlink)"
asset_dir_external="$TMP_ROOT/asset-dir-symlink-external"
mv "$asset_dir_symlink_fixture/dist/client/assets" "$asset_dir_external"
ln -s "$asset_dir_external" "$asset_dir_symlink_fixture/dist/client/assets"
asset_dir_external_target="$asset_dir_external/index-uI2AGFUy.js"
asset_dir_before="$(sha256_file "$asset_dir_external_target")"
for option in apply --check --restore; do
  if [[ "$option" == "apply" ]]; then
    expect_patch_failure "$asset_dir_symlink_fixture"
  else
    expect_patch_failure "$asset_dir_symlink_fixture" "$option"
  fi
done
[[ -L "$asset_dir_symlink_fixture/dist/client/assets" ]] || fail "asset directory symlink was replaced"
[[ "$(sha256_file "$asset_dir_external_target")" == "$asset_dir_before" ]] || fail "asset directory symlink destination was modified"
pass "all modes preserve index and intermediate asset-directory symlink rejection"

asset_fixture="$(make_fixture tampered-patch-asset)"
fake_repo="$TMP_ROOT/fake-repo"
mkdir -p "$fake_repo/scripts" "$fake_repo/patches/pi-web-mobile-paging/$VERSION"
cp "$APPLY_SCRIPT" "$fake_repo/scripts/"
cp "$PATCH_ASSET" "$fake_repo/patches/pi-web-mobile-paging/$VERSION/"
printf ' ' >> "$fake_repo/patches/pi-web-mobile-paging/$VERSION/client-message-page-size.patch.json"
chmod +x "$fake_repo/scripts/apply-pi-web-mobile-paging-patch.sh"
asset_before="$(sha256_file "$asset_fixture/$TARGET_REL")"
if PI_WEB_PACKAGE_ROOT="$asset_fixture" "$fake_repo/scripts/apply-pi-web-mobile-paging-patch.sh" >/dev/null 2>&1; then
  fail "tampered versioned patch asset was accepted"
fi
[[ "$(sha256_file "$asset_fixture/$TARGET_REL")" == "$asset_before" ]] || fail "tampered patch asset modified target"
pass "versioned patch asset itself is hash-gated"

transition_faults=(pre-rename-hash pre-rename-shape pre-rename-node-check rename)
for fault in "${transition_faults[@]}"; do
  fault_fixture="$(make_fixture "fault-apply-$fault")"
  fault_target="$fault_fixture/$TARGET_REL"
  chmod 751 "$fault_target"
  fault_reference="$TMP_ROOT/fault-apply-$fault.reference"
  cp "$fault_target" "$fault_reference"
  fault_hash="$(sha256_file "$fault_target")"
  fault_identity="$(file_identity "$fault_target")"
  fault_mode="$(file_mode "$fault_target")"
  fault_size="$(file_size "$fault_target")"
  expect_fault_failure "$fault_fixture" "$fault"
  cmp -s "$fault_target" "$fault_reference" || fail "$fault changed stock bytes"
  [[ "$(sha256_file "$fault_target")" == "$fault_hash" ]] || fail "$fault changed stock hash"
  [[ "$(file_identity "$fault_target")" == "$fault_identity" ]] || fail "$fault changed stock inode"
  [[ "$(file_mode "$fault_target")" == "$fault_mode" ]] || fail "$fault changed stock mode"
  [[ "$(file_size "$fault_target")" == "$fault_size" ]] || fail "$fault changed stock size"
  assert_no_patch_artifacts "$fault_fixture"
done
pass "final staged hash/shape/node-check and rename faults leave stock bytes, hash, inode, mode, and size unchanged"

for fault in "${transition_faults[@]}"; do
  fault_fixture="$(make_fixture "fault-restore-$fault")"
  fault_target="$fault_fixture/$TARGET_REL"
  chmod 751 "$fault_target"
  run_patch "$fault_fixture"
  fault_reference="$TMP_ROOT/fault-restore-$fault.reference"
  cp "$fault_target" "$fault_reference"
  fault_hash="$(sha256_file "$fault_target")"
  fault_identity="$(file_identity "$fault_target")"
  fault_mode="$(file_mode "$fault_target")"
  fault_size="$(file_size "$fault_target")"
  expect_fault_failure "$fault_fixture" "$fault" --restore
  cmp -s "$fault_target" "$fault_reference" || fail "$fault changed patched bytes during restore"
  [[ "$(sha256_file "$fault_target")" == "$fault_hash" ]] || fail "$fault changed patched hash during restore"
  [[ "$(file_identity "$fault_target")" == "$fault_identity" ]] || fail "$fault changed patched inode during restore"
  [[ "$(file_mode "$fault_target")" == "$fault_mode" ]] || fail "$fault changed patched mode during restore"
  [[ "$(file_size "$fault_target")" == "$fault_size" ]] || fail "$fault changed patched size during restore"
  assert_no_patch_artifacts "$fault_fixture"
done
pass "the same four pre-commit faults leave a patched restore target unchanged"

stale_lock_fixture="$(make_fixture stale-lock)"
stale_lock_target="$stale_lock_fixture/$TARGET_REL"
stale_lock_dir="$(dirname "$stale_lock_target")/.pi-web-mobile-paging.lock"
(umask 077; mkdir "$stale_lock_dir")
stale_lock_identity="$(file_identity "$stale_lock_dir")"
[[ "$(file_mode "$stale_lock_dir")" == "700" ]] || fail "fixture stale lock is not 0700"
[[ -z "$(find "$stale_lock_dir" -mindepth 1 -print -quit)" ]] || fail "fixture stale lock is not empty"
stale_lock_error="$TMP_ROOT/stale-lock.error"
if PI_WEB_PACKAGE_ROOT="$stale_lock_fixture" \
    PI_WEB_MOBILE_PAGING_TEST_FAULT=pre-rename-hash \
    "$APPLY_SCRIPT" >/dev/null 2>"$stale_lock_error"; then
  fail "apply ignored an existing exclusive lock"
fi
grep -Fq "remove this stale lock directory manually" "$stale_lock_error" || fail "stale lock error is not actionable"
expect_patch_failure "$stale_lock_fixture" --restore
expect_patch_failure "$stale_lock_fixture" --check
[[ -d "$stale_lock_dir" && ! -L "$stale_lock_dir" ]] || fail "failed process removed another process's lock"
[[ "$(file_identity "$stale_lock_dir")" == "$stale_lock_identity" ]] || fail "failed process replaced another process's lock"
rmdir "$stale_lock_dir"
run_patch "$stale_lock_fixture"
(umask 077; mkdir "$stale_lock_dir")
stale_lock_identity="$(file_identity "$stale_lock_dir")"
run_patch "$stale_lock_fixture" --check
[[ "$(file_identity "$stale_lock_dir")" == "$stale_lock_identity" ]] || fail "lockless --check changed an existing lock"
rmdir "$stale_lock_dir"
assert_no_patch_artifacts "$stale_lock_fixture"
pass "0700 empty stale locks fail fast with recovery guidance, remain owned by their creator, and do not block read-only --check"

lock_owner_fixture="$(make_fixture lock-owner-swap)"
lock_owner_target="$lock_owner_fixture/$TARGET_REL"
lock_owner_dir="$(dirname "$lock_owner_target")/.pi-web-mobile-paging.lock"
lock_owner_reference="$TMP_ROOT/lock-owner.reference"
cp "$lock_owner_target" "$lock_owner_reference"
lock_owner_hash="$(sha256_file "$lock_owner_target")"
lock_owner_identity="$(file_identity "$lock_owner_target")"
lock_owner_mode="$(file_mode "$lock_owner_target")"
lock_owner_size="$(file_size "$lock_owner_target")"
lock_owner_stdout="$TMP_ROOT/lock-owner.stdout"
lock_owner_stderr="$TMP_ROOT/lock-owner.stderr"
PI_WEB_PACKAGE_ROOT="$lock_owner_fixture" \
PI_WEB_MOBILE_PAGING_TEST_FAULT=pre-rename-shape \
  "$APPLY_SCRIPT" >"$lock_owner_stdout" 2>"$lock_owner_stderr" &
lock_owner_pid=$!
lock_owner_stage=""
for _ in $(seq 1 1000); do
  lock_owner_stage="$(find "$(dirname "$lock_owner_target")" -maxdepth 1 -name '*.pi-web-mobile-paging.stage.*' -print -quit)"
  [[ -n "$lock_owner_stage" ]] && break
  sleep 0.005
done
[[ -n "$lock_owner_stage" ]] || {
  wait "$lock_owner_pid" 2>/dev/null || true
  fail "could not observe the validation-failure process's owned stage"
}
kill -STOP "$lock_owner_pid" 2>/dev/null || fail "could not pause the lock owner"
sleep 0.05
[[ -d "$lock_owner_dir" && ! -L "$lock_owner_dir" ]] || fail "lock owner did not create a real lock directory"
[[ "$(file_mode "$lock_owner_dir")" == "700" ]] || fail "owned lock is not 0700"
[[ -z "$(find "$lock_owner_dir" -mindepth 1 -print -quit)" ]] || fail "owned lock contains metadata"
old_lock_identity="$(file_identity "$lock_owner_dir")"
rmdir "$lock_owner_dir"
lock_inode_bump="$(dirname "$lock_owner_target")/.pi-web-mobile-paging.inode-bump"
(umask 077; mkdir "$lock_inode_bump"; mkdir "$lock_owner_dir"; rmdir "$lock_inode_bump")
replacement_lock_identity="$(file_identity "$lock_owner_dir")"
[[ "$replacement_lock_identity" != "$old_lock_identity" ]] || fail "lock replacement unexpectedly reused the same inode"
kill -CONT "$lock_owner_pid" 2>/dev/null || fail "could not resume the lock owner"
set +e
wait "$lock_owner_pid"
lock_owner_status=$?
set -e
[[ "$lock_owner_status" -ne 0 ]] || fail "injected validation failure unexpectedly succeeded after lock replacement"
[[ -d "$lock_owner_dir" && ! -L "$lock_owner_dir" ]] || fail "validation-failure trap deleted a replacement lock"
[[ "$(file_identity "$lock_owner_dir")" == "$replacement_lock_identity" ]] || fail "validation-failure trap changed a replacement lock"
rmdir "$lock_owner_dir"
cmp -s "$lock_owner_target" "$lock_owner_reference" || fail "lock ownership race changed target bytes"
[[ "$(sha256_file "$lock_owner_target")" == "$lock_owner_hash" ]] || fail "lock ownership race changed target hash"
[[ "$(file_identity "$lock_owner_target")" == "$lock_owner_identity" ]] || fail "lock ownership race changed target inode"
[[ "$(file_mode "$lock_owner_target")" == "$lock_owner_mode" ]] || fail "lock ownership race changed target mode"
[[ "$(file_size "$lock_owner_target")" == "$lock_owner_size" ]] || fail "lock ownership race changed target size"
assert_no_patch_artifacts "$lock_owner_fixture"
pass "a validation-failure trap removes only its own lock identity, never a replacement lock"

same_direction_fixture="$(make_fixture concurrent-40-apply)"
same_direction_target="$same_direction_fixture/$TARGET_REL"
same_direction_results="$TMP_ROOT/concurrent-40-results"
same_direction_gate="$same_direction_results/start"
mkdir -p "$same_direction_results" "$TMP_ROOT/command-tmp"
same_direction_pids=()
for i in $(seq 1 40); do
  (
    while [[ ! -e "$same_direction_gate" ]]; do sleep 0.005; done
    set +e
    PI_WEB_PACKAGE_ROOT="$same_direction_fixture" TMPDIR="$TMP_ROOT/command-tmp" \
      "$APPLY_SCRIPT" >"$same_direction_results/$i.out" 2>"$same_direction_results/$i.err"
    status=$?
    printf '%s\n' "$status" > "$same_direction_results/$i.status"
    exit 0
  ) &
  same_direction_pids+=("$!")
done
: > "$same_direction_gate"
for pid in "${same_direction_pids[@]}"; do wait "$pid"; done
same_installed=0
same_idempotent=0
same_locked=0
for i in $(seq 1 40); do
  status="$(<"$same_direction_results/$i.status")"
  if [[ "$status" == "0" ]]; then
    if grep -Fq "Installed PI WEB" "$same_direction_results/$i.out"; then
      same_installed=$((same_installed + 1))
    elif grep -Fq "already installed" "$same_direction_results/$i.out"; then
      same_idempotent=$((same_idempotent + 1))
    else
      fail "concurrent apply $i succeeded without transition/idempotent semantics"
    fi
  elif grep -Fq "Exclusive mobile paging lock exists" "$same_direction_results/$i.err"; then
    same_locked=$((same_locked + 1))
  else
    fail "concurrent apply $i failed for a reason other than exclusion"
  fi
done
[[ "$same_installed" == "1" ]] || fail "40 concurrent applies committed $same_installed transitions instead of exactly one"
[[ $((same_installed + same_idempotent + same_locked)) == 40 ]] || fail "40 concurrent apply results were not fully classified"
[[ "$(sha256_file "$same_direction_target")" == "$PATCHED_SHA256" ]] || fail "40 concurrent applies did not finish patched"
assert_no_patch_artifacts "$same_direction_fixture"
pass "40 same-direction applies yield one commit plus only idempotent/lock outcomes, ending patched without artifacts"

mixed_fixture="$(make_fixture concurrent-20-mixed)"
mixed_target="$mixed_fixture/$TARGET_REL"
mixed_results="$TMP_ROOT/concurrent-20-results"
mixed_gate="$mixed_results/start"
mkdir -p "$mixed_results"
mixed_pids=()
for i in $(seq 1 20); do
  if (( i % 2 == 0 )); then mixed_operation="apply"; else mixed_operation="restore"; fi
  printf '%s\n' "$mixed_operation" > "$mixed_results/$i.operation"
  (
    while [[ ! -e "$mixed_gate" ]]; do sleep 0.005; done
    set +e
    if [[ "$mixed_operation" == "apply" ]]; then
      PI_WEB_PACKAGE_ROOT="$mixed_fixture" TMPDIR="$TMP_ROOT/command-tmp" \
        "$APPLY_SCRIPT" >"$mixed_results/$i.out" 2>"$mixed_results/$i.err"
    else
      PI_WEB_PACKAGE_ROOT="$mixed_fixture" TMPDIR="$TMP_ROOT/command-tmp" \
        "$APPLY_SCRIPT" --restore >"$mixed_results/$i.out" 2>"$mixed_results/$i.err"
    fi
    status=$?
    printf '%s\n' "$status" > "$mixed_results/$i.status"
    exit 0
  ) &
  mixed_pids+=("$!")
done
: > "$mixed_gate"
for pid in "${mixed_pids[@]}"; do wait "$pid"; done
mixed_installed=0
mixed_restored=0
mixed_idempotent=0
mixed_locked=0
for i in $(seq 1 20); do
  operation="$(<"$mixed_results/$i.operation")"
  status="$(<"$mixed_results/$i.status")"
  if [[ "$status" == "0" ]]; then
    if [[ "$operation" == "apply" ]] && grep -Fq "Installed PI WEB" "$mixed_results/$i.out"; then
      mixed_installed=$((mixed_installed + 1))
    elif [[ "$operation" == "apply" ]] && grep -Fq "already installed" "$mixed_results/$i.out"; then
      mixed_idempotent=$((mixed_idempotent + 1))
    elif [[ "$operation" == "restore" ]] && grep -Fq "Restored the exact official" "$mixed_results/$i.out"; then
      mixed_restored=$((mixed_restored + 1))
    elif [[ "$operation" == "restore" ]] && grep -Fq "already restored" "$mixed_results/$i.out"; then
      mixed_idempotent=$((mixed_idempotent + 1))
    else
      fail "mixed concurrent command $i succeeded with semantics inconsistent with its operation"
    fi
  elif grep -Fq "Exclusive mobile paging lock exists" "$mixed_results/$i.err"; then
    mixed_locked=$((mixed_locked + 1))
  else
    fail "mixed concurrent command $i failed for a reason other than exclusion"
  fi
done
mixed_final_hash="$(sha256_file "$mixed_target")"
case "$mixed_final_hash" in
  "$STOCK_SHA256") expected_transition_delta=0 ;;
  "$PATCHED_SHA256") expected_transition_delta=1 ;;
  *) fail "mixed concurrency produced an unknown final bundle hash: $mixed_final_hash" ;;
esac
[[ $((mixed_installed - mixed_restored)) == "$expected_transition_delta" ]] || \
  fail "mixed successful transitions cannot be linearized from stock to the final state"
[[ $((mixed_installed + mixed_restored + mixed_idempotent + mixed_locked)) == 20 ]] || \
  fail "20 mixed concurrent results were not fully classified"
assert_no_patch_artifacts "$mixed_fixture"
pass "20 opposing apply/restore commands have serializable success semantics and end in a known exact state without artifacts"

setup_fixture="$(make_fixture setup-wiring)"
setup_global="$TMP_ROOT/setup-global"
mkdir -p "$setup_global/@jmfederico"
mv "$setup_fixture" "$setup_global/@jmfederico/pi-web"
setup_fixture="$setup_global/@jmfederico/pi-web"
fake_home="$TMP_ROOT/setup-home"
fake_bin="$TMP_ROOT/setup-bin"
fake_data="$TMP_ROOT/setup-data"
fake_log="$TMP_ROOT/setup-command.log"
mkdir -p "$fake_home/.config/pi-web" "$fake_bin" "$fake_data"
cat > "$fake_home/.config/pi-web/config.json" <<'JSON'
{
  "host": "127.0.0.1",
  "port": 8504,
  "allowedHosts": [],
  "pathAccess": { "allowedPaths": [] },
  "spawnSessions": false,
  "subsessions": false,
  "askUser": true,
  "environmentFacts": false,
  "plugins": {
    "git": { "enabled": true },
    "info": { "enabled": true },
    "updates": { "enabled": false },
    "workspace-tasks": { "enabled": false },
    "relays": { "enabled": false }
  }
}
JSON
chmod 600 "$fake_home/.config/pi-web/config.json"

cat > "$fake_bin/npm" <<'SH'
#!/usr/bin/env bash
printf 'npm %s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "${1:-}" in
  --version) echo 11.0.0 ;;
  root) [[ "${2:-}" == "-g" ]] || exit 2; echo "$FAKE_NPM_ROOT" ;;
  install) ;;
  *) exit 2 ;;
esac
SH
cat > "$fake_bin/pi" <<'SH'
#!/usr/bin/env bash
printf 'pi %s\n' "$*" >> "$FAKE_COMMAND_LOG"
[[ "${1:-}" == "--version" ]] || exit 2
echo 0.84.1
SH
cat > "$fake_bin/pi-web" <<'SH'
#!/usr/bin/env bash
printf 'pi-web %s\n' "$*" >> "$FAKE_COMMAND_LOG"
case "${1:-}" in install|start|doctor|status) exit 0 ;; *) exit 2 ;; esac
SH
cat > "$fake_bin/curl" <<'SH'
#!/usr/bin/env bash
printf 'curl %s\n' "$*" >> "$FAKE_COMMAND_LOG"
exit 0
SH
cat > "$fake_bin/uname" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "-s" ]]; then echo Linux; elif [[ "${1:-}" == "-m" ]]; then echo x86_64; else echo Linux; fi
SH
chmod +x "$fake_bin"/*

socket_path="$fake_data/sessiond.sock"
python3 - "$socket_path" <<'PY' &
import signal, socket, sys, time
sock = socket.socket(socket.AF_UNIX)
sock.bind(sys.argv[1])
sock.listen(1)
signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
while True: time.sleep(1)
PY
SOCKET_PID="$!"
for _ in $(seq 1 100); do [[ -S "$socket_path" ]] && break; sleep 0.02; done
[[ -S "$socket_path" ]] || fail "could not create setup test socket"

setup_env=(
  "HOME=$fake_home"
  "PATH=$fake_bin:$PATH"
  "PI_WEB_DATA_DIR=$fake_data"
  "FAKE_NPM_ROOT=$setup_global"
  "FAKE_COMMAND_LOG=$fake_log"
)
if env "${setup_env[@]}" bash "$SETUP_SCRIPT" --check >/dev/null 2>&1; then
  fail "setup --check accepted a stock client bundle"
fi
[[ "$(sha256_file "$setup_fixture/$TARGET_REL")" == "$STOCK_SHA256" ]] || fail "setup --check modified stock"
pass "setup --check wires to paging --check and does not auto-apply"

env "${setup_env[@]}" bash "$SETUP_SCRIPT" >/dev/null
[[ "$(sha256_file "$setup_fixture/$TARGET_REL")" == "$PATCHED_SHA256" ]] || fail "normal setup did not apply paging patch"
pass "normal setup/repair applies the paging patch after the fixed package install"

setup_identity="$(file_identity "$setup_fixture/$TARGET_REL")"
env "${setup_env[@]}" bash "$SETUP_SCRIPT" --check >/dev/null
[[ "$(file_identity "$setup_fixture/$TARGET_REL")" == "$setup_identity" ]] || fail "setup --check replaced patched bundle"
[[ "$(grep -c '^npm install ' "$fake_log" || true)" == "1" ]] || fail "setup check unexpectedly installed npm packages"
if grep -q '^pi-web restart' "$fake_log"; then fail "setup automatically restarted PI WEB"; fi
pass "setup verification is idempotent and never invokes pi-web restart"

[[ "$(sha256_file "$STOCK_SOURCE/$TARGET_REL")" == "$SOURCE_HASH_BEFORE" ]] || fail "read-only stock source was modified"
if find "$TMP_ROOT" -type f \( -name '*.orig' -o -name '*.rej' -o -name '*~' \) -print -quit | grep -q .; then
  fail "a backup/reject file remains in the test tree"
fi
pass "stock source remains untouched and no backup/reject artifacts are created"

echo "All $TEST_COUNT tests passed."
