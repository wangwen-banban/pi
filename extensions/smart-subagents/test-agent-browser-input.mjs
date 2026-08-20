import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { resolveAgentBrowserInput } from "./agent-browser-input.ts";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const keysModule = await import(pathToFileURL(join(
	globalRoot,
	"@earendil-works",
	"pi-coding-agent",
	"node_modules",
	"@earendil-works",
	"pi-tui",
	"dist",
	"keys.js",
)).href);
const { Key, matchesKey } = keysModule;

const bindingKeys = {
	"tui.select.up": Key.up,
	"tui.select.down": Key.down,
	"tui.select.pageUp": Key.pageUp,
	"tui.select.pageDown": Key.pageDown,
	"tui.select.confirm": Key.enter,
	"tui.select.cancel": Key.escape,
};

const defaultKeybindings = {
	matches(data, binding) {
		return matchesKey(data, bindingKeys[binding]);
	},
};

function action(data, detail = true, keybindings = defaultKeybindings) {
	return resolveAgentBrowserInput(data, detail, keybindings, matchesKey);
}

test("macOS Option+Up/Down legacy sequences page through detail output", () => {
	assert.equal(matchesKey("\x1bp", Key.alt("up")), true, "Pi TUI recognizes legacy Option+Up");
	assert.equal(matchesKey("\x1bn", Key.alt("down")), true, "Pi TUI recognizes legacy Option+Down");
	assert.equal(action("\x1bp"), "page-up");
	assert.equal(action("\x1bn"), "page-down");
});

test("modern Alt+Arrow CSI sequences page through detail output", () => {
	assert.equal(matchesKey("\x1b[1;3A", Key.alt("up")), true);
	assert.equal(matchesKey("\x1b[1;3B", Key.alt("down")), true);
	assert.equal(action("\x1b[1;3A"), "page-up");
	assert.equal(action("\x1b[1;3B"), "page-down");
});

test("physical PageUp/PageDown and user-configured selection bindings work", () => {
	assert.equal(action("\x1b[5~"), "page-up");
	assert.equal(action("\x1b[6~"), "page-down");
	const custom = {
		matches(data, binding) {
			return (data === "CUSTOM_UP" && binding === "tui.select.pageUp")
				|| (data === "CUSTOM_DOWN" && binding === "tui.select.pageDown");
		},
	};
	assert.equal(action("CUSTOM_UP", true, custom), "page-up");
	assert.equal(action("CUSTOM_DOWN", true, custom), "page-down");
});

test("detail mode keeps line, top, bottom, back and close actions distinct", () => {
	assert.equal(action("\x1b[A"), "line-up");
	assert.equal(action("\x1b[B"), "line-down");
	assert.equal(action("\x1b[H"), "top");
	assert.equal(action("\x1b[F"), "bottom");
	assert.equal(action("\x1b[D"), "back");
	assert.equal(action("q"), "close");
	assert.equal(action("\x1b"), "back");
});

test("list mode uses selection bindings and never treats Option+Arrow as selection movement", () => {
	assert.equal(action("\x1b[A", false), "select-up");
	assert.equal(action("\x1b[B", false), "select-down");
	assert.equal(action("\r", false), "inspect");
	assert.equal(action("\x1b[C", false), "inspect");
	assert.equal(action("\x1b", false), "close");
	assert.equal(action("\x1bp", false), undefined);
	assert.equal(action("\x1bn", false), undefined);
});
