import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { withEditorFocus } from "./focusable-editor.ts";

test("outer component focus is propagated to the embedded Editor", () => {
	const editor = { focused: false };
	let invalidations = 0;
	const component = {
		render: () => ["dialog"],
		handleInput: () => {},
		invalidate: () => { invalidations += 1; },
	};
	const wrapped = withEditorFocus(component, editor);
	assert.equal(wrapped, component, "wrapper keeps the original component identity");
	assert.equal("focused" in wrapped, true, "TUI can detect the outer component as Focusable");
	assert.equal(wrapped.focused, false);
	wrapped.focused = true;
	assert.equal(editor.focused, true);
	assert.equal(wrapped.focused, true);
	wrapped.focused = false;
	assert.equal(editor.focused, false);
	wrapped.invalidate();
	assert.equal(invalidations, 1, "component methods remain intact");
});

test("both embedded Plan Mode editors use focus propagation and invalidate their child", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.equal((source.match(/withEditorFocus\(\{/g) ?? []).length, 2);
	assert.equal((source.match(/editor\.invalidate\(\)/g) ?? []).length, 2);
	assert.doesNotMatch(source, /return \{ render, invalidate: \(\) => \{ cachedLines = undefined; \}, handleInput \};/);
});
