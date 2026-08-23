import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createStatuslineFlagState } from "./model-state.ts";

test("Fast indicator state re-renders immediately and detaches cleanly", () => {
	const state = createStatuslineFlagState();
	let renders = 0;
	const unbind = state.bindRender(() => { renders += 1; });
	assert.equal(state.get(), false);
	state.set(true);
	assert.equal(state.get(), true);
	assert.equal(renders, 1);
	state.set(true);
	assert.equal(renders, 1, "same state does not cause footer flicker");
	state.set(false);
	assert.equal(renders, 2);
	unbind();
	state.set(true);
	assert.equal(renders, 2, "disposed footer does not receive renders");
});

test("custom statusline consumes Fast events and renders a visible label", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /pi\.events\.on\(CODEX_FAST_EVENT/);
	assert.match(source, /fastMode\.bindRender\(\(\) => tui\.requestRender\(\)\)/);
	assert.match(source, /fastMode\.get\(\) \? theme\.fg\("warning", "⚡FAST"\)/);
	assert.match(source, /unbindFastRender\(\)/);
});
