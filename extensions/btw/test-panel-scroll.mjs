import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	applyBtwPaging,
	createBtwScrollState,
	layoutBtwViewport,
	resolveBtwPagingInput,
} from "./panel-scroll.ts";

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

const defaultKeybindings = {
	matches(data, binding) {
		if (binding === "tui.select.pageUp") return matchesKey(data, Key.pageUp);
		if (binding === "tui.select.pageDown") return matchesKey(data, Key.pageDown);
		return false;
	},
};

test("macOS Fn+Up/Down standard PageUp/PageDown sequences are recognized", () => {
	assert.equal(resolveBtwPagingInput("\x1b[5~", defaultKeybindings), "page-up");
	assert.equal(resolveBtwPagingInput("\x1b[6~", defaultKeybindings), "page-down");
	assert.equal(resolveBtwPagingInput("\x1b[[5~", defaultKeybindings), "page-up");
	assert.equal(resolveBtwPagingInput("\x1b[[6~", defaultKeybindings), "page-down");
	assert.equal(resolveBtwPagingInput("\x1b[57421u", defaultKeybindings), "page-up");
	assert.equal(resolveBtwPagingInput("\x1b[57422u", defaultKeybindings), "page-down");
});

test("Option+Arrow is deliberately not captured by BTW paging", () => {
	assert.equal(resolveBtwPagingInput("\x1bp", defaultKeybindings), undefined);
	assert.equal(resolveBtwPagingInput("\x1bn", defaultKeybindings), undefined);
	assert.equal(resolveBtwPagingInput("\x1b[1;3A", defaultKeybindings), undefined);
	assert.equal(resolveBtwPagingInput("\x1b[1;3B", defaultKeybindings), undefined);
});

test("custom tui.select.pageUp/pageDown bindings remain supported", () => {
	const custom = {
		matches(data, binding) {
			return (data === "CUSTOM_UP" && binding === "tui.select.pageUp")
				|| (data === "CUSTOM_DOWN" && binding === "tui.select.pageDown");
		},
	};
	assert.equal(resolveBtwPagingInput("CUSTOM_UP", custom), "page-up");
	assert.equal(resolveBtwPagingInput("CUSTOM_DOWN", custom), "page-down");
});

test("page size follows the viewport and PageDown resumes bottom follow", () => {
	const state = createBtwScrollState();
	let viewport = layoutBtwViewport(state, 100, 20);
	assert.deepEqual(viewport, { start: 80, end: 100, maxScroll: 80 });
	assert.equal(state.pageSize, 19);
	applyBtwPaging(state, "page-up");
	viewport = layoutBtwViewport(state, 100, 20);
	assert.deepEqual(viewport, { start: 61, end: 81, maxScroll: 80 });
	assert.equal(state.followOutput, false);
	applyBtwPaging(state, "page-down");
	viewport = layoutBtwViewport(state, 100, 20);
	assert.deepEqual(viewport, { start: 80, end: 100, maxScroll: 80 });
	assert.equal(state.followOutput, true);
});

test("streaming growth preserves the absolute history viewport while paused", () => {
	const state = createBtwScrollState();
	layoutBtwViewport(state, 100, 20);
	applyBtwPaging(state, "page-up");
	const before = layoutBtwViewport(state, 100, 20);
	assert.equal(before.end, 81);
	const after = layoutBtwViewport(state, 112, 20);
	assert.equal(after.end, 81, "new output must not snap or drift the history viewport");
	assert.equal(state.scrollBack, 31);
	assert.equal(state.followOutput, false);
});
