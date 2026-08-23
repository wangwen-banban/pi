import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	CODEX_FAST_EVENT,
	CODEX_FAST_MARKER_TYPE,
	applyCodexFastServiceTier,
	buildFastModeMarker,
	fastCreditMultiplier,
	fastModeEvent,
	isCodexFastModel,
	reconstructFastMode,
} from "./fast-mode.ts";

const model = (provider, id) => ({ provider, id });

test("Fast support follows the current Codex catalog and excludes 5.4-mini/non-Codex", () => {
	for (const provider of ["openai-codex", "openai-codex-second"]) {
		for (const id of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]) {
			assert.equal(isCodexFastModel(model(provider, id)), true, `${provider}/${id}`);
		}
		assert.equal(isCodexFastModel(model(provider, "gpt-5.4-mini")), false);
	}
	assert.equal(isCodexFastModel(model("openai", "gpt-5.6-sol")), false);
	assert.equal(isCodexFastModel(model("opencode-go", "gpt-5.6-sol")), false);
	assert.equal(isCodexFastModel(undefined), false);
});

test("Fast stream option injects priority only when enabled and supported", () => {
	const original = { reasoningEffort: "xhigh", serviceTier: "default", custom: 1 };
	const fast = applyCodexFastServiceTier(original, model("openai-codex", "gpt-5.6-sol"), true);
	assert.deepEqual(fast, { reasoningEffort: "xhigh", serviceTier: "priority", custom: 1 });
	assert.deepEqual(original, { reasoningEffort: "xhigh", serviceTier: "default", custom: 1 }, "input is not mutated");
	assert.equal(applyCodexFastServiceTier(original, model("openai-codex", "gpt-5.6-sol"), false), original);
	assert.equal(applyCodexFastServiceTier(original, model("openai", "gpt-5.6-sol"), true), original);
	assert.deepEqual(applyCodexFastServiceTier(undefined, model("openai-codex-second", "gpt-5.6-luna"), true), { serviceTier: "priority" });
});

test("branch markers reconstruct the newest on/off selection", () => {
	const on = buildFastModeMarker(true, 10);
	const off = buildFastModeMarker(false, 20);
	assert.deepEqual(on, { enabled: true, timestamp: 10 });
	assert.equal(reconstructFastMode([
		{ type: "custom", customType: CODEX_FAST_MARKER_TYPE, data: on },
		{ type: "message" },
	]), true);
	assert.equal(reconstructFastMode([
		{ type: "custom", customType: CODEX_FAST_MARKER_TYPE, data: on },
		{ type: "custom", customType: CODEX_FAST_MARKER_TYPE, data: off },
	]), false);
	assert.equal(reconstructFastMode([]), false);
});

test("event state and official ChatGPT credit multipliers are explicit", () => {
	assert.equal(CODEX_FAST_EVENT, "codex-fast-mode:changed");
	assert.deepEqual(fastModeEvent(true, model("openai-codex-second", "gpt-5.6-sol")), {
		enabled: true,
		active: true,
		supported: true,
		provider: "openai-codex-second",
		modelId: "gpt-5.6-sol",
		serviceTier: "priority",
	});
	assert.equal(fastModeEvent(true, model("openai", "gpt-5.6-sol")).active, false);
	assert.equal(fastCreditMultiplier("gpt-5.6-sol"), 2.5);
	assert.equal(fastCreditMultiplier("gpt-5.5"), 2.5);
	assert.equal(fastCreditMultiplier("gpt-5.4"), 2);
	assert.equal(fastCreditMultiplier("gpt-5.4-mini"), undefined);
});

test("provider-routing wires session state, /fast and typed stream options", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /registerCommand\("fast"/);
	assert.match(source, /applyCodexFastServiceTier\(options, model, fastModeEnabled\)/);
	assert.match(source, /serviceTier\?: string/);
	assert.match(source, /reconstructFastMode\(ctx\.sessionManager\.getBranch\(\)/);
	assert.match(source, /pi\.events\.emit\(CODEX_FAST_EVENT, state\)/);
	assert.match(source, /fastCreditMultiplier\(state\.modelId\)/);
	assert.match(source, /ChatGPT credits/);
});
