#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPLY_SCRIPT="$SCRIPT_DIR/apply-history-navigation-patch.sh"
VERSION="0.84.1"
STOCK_SHA256="a384c140d84e5352605250fab0e1284add133dbdda1e986419c4a0778ffa0853"
PATCHED_SHA256="5a765439ec4f415d9a9720d6651ddd693333ee2f6899be6efaca63eb6b2c7aaf"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/pi-history-navigation-test.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

cd "$TMP_DIR"
TARBALL="$(npm pack "@earendil-works/pi-tui@$VERSION" --silent)"
tar -xzf "$TARBALL"
TUI_SOURCE="$TMP_DIR/package"
AGENT_ROOT="$TMP_DIR/agent"
mkdir -p "$AGENT_ROOT/node_modules/@earendil-works"
cp -R "$TUI_SOURCE" "$AGENT_ROOT/node_modules/@earendil-works/pi-tui"
# npm pack intentionally omits dependencies; reuse the matching dependencies from
# the installed coding-agent package when available, without assuming its prefix.
GLOBAL_AGENT="$(npm root -g)/@earendil-works/pi-coding-agent"
for dependency in get-east-asian-width marked; do
  if [[ -d "$GLOBAL_AGENT/node_modules/$dependency" ]]; then
    ln -s "$GLOBAL_AGENT/node_modules/$dependency" "$AGENT_ROOT/node_modules/$dependency"
  fi
done
cat > "$AGENT_ROOT/package.json" <<'EOF'
{"name":"@earendil-works/pi-coding-agent","version":"0.84.1","dependencies":{"@earendil-works/pi-tui":"^0.84.1"}}
EOF
TARGET="$AGENT_ROOT/node_modules/@earendil-works/pi-tui/dist/components/editor.js"

[[ "$(sha256_file "$TARGET")" == "$STOCK_SHA256" ]] || { echo "Unexpected official pi-tui stock hash" >&2; exit 1; }
if PI_PACKAGE_ROOT="$AGENT_ROOT" "$APPLY_SCRIPT" --check >/dev/null 2>&1; then
  echo "Expected --check to reject the official stock package" >&2
  exit 1
fi
[[ "$(sha256_file "$TARGET")" == "$STOCK_SHA256" ]]
echo "✓ --check rejects stock pi-tui without modifying it"

PI_PACKAGE_ROOT="$AGENT_ROOT" "$APPLY_SCRIPT" >/dev/null
[[ "$(sha256_file "$TARGET")" == "$PATCHED_SHA256" ]]
node --check "$TARGET" >/dev/null
PI_PACKAGE_ROOT="$AGENT_ROOT" "$APPLY_SCRIPT" --check >/dev/null
PI_PACKAGE_ROOT="$AGENT_ROOT" "$APPLY_SCRIPT" >/dev/null
[[ "$(sha256_file "$TARGET")" == "$PATCHED_SHA256" ]]
echo "✓ official pi-tui $VERSION patches exactly and apply/check are idempotent"

printf '\n// incompatible local edit\n' >> "$TARGET"
UNKNOWN_BEFORE="$(sha256_file "$TARGET")"
if PI_PACKAGE_ROOT="$AGENT_ROOT" "$APPLY_SCRIPT" >/dev/null 2>&1; then
  echo "Expected apply to reject an unknown editor hash" >&2
  exit 1
fi
[[ "$(sha256_file "$TARGET")" == "$UNKNOWN_BEFORE" ]]
echo "✓ unknown/incompatible target is rejected without overwrite"

TARGET="$TARGET" TUI_ROOT="$AGENT_ROOT/node_modules/@earendil-works/pi-tui" node --input-type=module <<'NODE'
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const target = process.env.TARGET;
const tuiRoot = process.env.TUI_ROOT;
const { Editor } = await import(pathToFileURL(target).href);
const { KeybindingsManager, TUI_KEYBINDINGS, setKeybindings } = await import(pathToFileURL(path.join(tuiRoot, "dist/keybindings.js")).href);

const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, {
  "tui.editor.historyPrevious": "ctrl+p",
  "tui.editor.historyNext": "ctrl+n",
});
setKeybindings(keybindings);

function editor(draft = "") {
  const e = new Editor({ terminal: { rows: 24 }, requestRender() {} }, { borderColor: (s) => s });
  e.addToHistory("older entry\nwith two lines");
  e.addToHistory("newest entry\nwith two lines");
  e.setText(draft);
  return e;
}
function arrow(e, direction) {
  e.handleInput(direction === "up" ? "\x1b[A" : "\x1b[B");
}
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

check("empty draft ↑↑↓ returns newest history", () => {
  const e = editor("");
  arrow(e, "up");
  assert.equal(e.historyIndex, 0);
  assert.equal(e.getText(), "newest entry\nwith two lines");
  arrow(e, "up");
  assert.equal(e.historyIndex, 1);
  arrow(e, "down");
  assert.equal(e.historyIndex, 0);
});
check("crossing newest restores complete non-empty draft", () => {
  const e = editor("draft line 1\ndraft line 2");
  e.state.cursorLine = 0;
  e.state.cursorCol = 0;
  arrow(e, "up");
  arrow(e, "down");
  arrow(e, "down");
  assert.equal(e.historyIndex, -1);
  assert.equal(e.getText(), "draft line 1\ndraft line 2");
});
check("oldest boundary is a no-op", () => {
  const e = editor("");
  arrow(e, "up");
  arrow(e, "up");
  const before = e.getText();
  arrow(e, "up");
  assert.equal(e.historyIndex, 1);
  assert.equal(e.getText(), before);
});
check("ordinary multiline ↑/↓ remains visual cursor movement", () => {
  const e = editor("first line\nsecond line");
  e.render(80);
  arrow(e, "up");
  assert.equal(e.historyIndex, -1);
  assert.equal(e.state.cursorLine, 0);
  arrow(e, "down");
  assert.equal(e.historyIndex, -1);
  assert.equal(e.state.cursorLine, 1);
});
check("ordinary wrapped draft keeps cursor navigation", () => {
  const e = editor("abcdefghijABCDEFGHIJ");
  e.render(10);
  arrow(e, "up");
  assert.equal(e.historyIndex, -1);
  arrow(e, "down");
  assert.equal(e.historyIndex, -1);
});
check("browse arrows skip recalled multiline visual lines", () => {
  const e = editor("");
  arrow(e, "up");
  const recalled = e.getText();
  arrow(e, "up");
  assert.equal(e.historyIndex, 1);
  assert.notEqual(e.getText(), recalled);
  arrow(e, "down");
  assert.equal(e.historyIndex, 0);
  assert.equal(e.getText(), recalled);
});
check("editing recalled text exits browse mode", () => {
  const e = editor("");
  arrow(e, "up");
  e.handleInput("!");
  assert.equal(e.historyIndex, -1);
  assert.match(e.getText(), /^!/);
  arrow(e, "down");
  assert.equal(e.historyIndex, -1);
});
check("explicit historyPrevious/historyNext actions remain usable", () => {
  const e = editor("");
  e.handleInput("\x10");
  assert.equal(e.historyIndex, 0);
  e.handleInput("\x0e");
  assert.equal(e.historyIndex, -1);
  assert.equal(e.getText(), "");
});
check("large paste marker and expanded draft survive history round trip", () => {
  const pasted = Array.from({ length: 12 }, (_, i) => `line-${i}-${"x".repeat(100)}`).join("\n");
  const e = editor("");
  e.handleInput(`\x1b[200~${pasted}\x1b[201~`);
  const marker = e.getText();
  assert.match(marker, /^\[paste #1 \+12 lines\]$/);
  assert.equal(e.getExpandedText(), pasted);
  arrow(e, "up");
  arrow(e, "down");
  assert.equal(e.getText(), marker);
  assert.equal(e.getExpandedText(), pasted);
});

console.log(`✓ behavior tests: ${passed}`);
NODE
