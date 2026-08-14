import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCodexCachePath, getCodexProviderId } from "../weekly-usage-status/codex-provider.ts";
import { formatResetCountdown } from "../weekly-usage-status/usage.ts";
import { createActiveModelState, getRoutingProviderForStatusline } from "./model-state.ts";

const base = 1_700_000_000_000;
const countdownCases = [
	[undefined, undefined],
	[base / 1000, "now"],
	[base / 1000 + 20, "1m"],
	[base / 1000 + 65 * 60, "1h 5m"],
	[base / 1000 + 2 * 86_400 + 3 * 3600, "2d 3h"],
];
for (const [at, expected] of countdownCases) {
	const actual = formatResetCountdown(at, base);
	assert.equal(actual, expected);
	console.log(`✓ ${String(at)} -> ${String(actual)}`);
}

const agentDir = mkdtempSync(join(tmpdir(), "pi-codex-statusline-"));
try {
	mkdirSync(join(agentDir, "cache"), { recursive: true });
	writeFileSync(
		getCodexCachePath(agentDir, "openai-codex"),
		JSON.stringify({ remainingPercent: 76, resetsAt: base / 1000 + 65 * 60 }),
	);
	writeFileSync(
		getCodexCachePath(agentDir, "openai-codex-second"),
		JSON.stringify({ remainingPercent: 98, resetsAt: base / 1000 + 2 * 86_400 }),
	);

	const state = createActiveModelState({
		provider: "openai-codex",
		id: "gpt-5.6-sol",
		contextWindow: 400_000,
	});
	let renders = 0;
	const unbind = state.bindRender(() => renders++);
	const quotaForActiveModel = () => {
		const provider = getCodexProviderId(state.get()?.provider);
		assert.ok(provider);
		return JSON.parse(readFileSync(getCodexCachePath(agentDir, provider), "utf8"));
	};

	assert.equal(quotaForActiveModel().remainingPercent, 76);
	state.set({
		provider: "openai-codex-second",
		id: "gpt-5.6-sol",
		contextWindow: 400_000,
	});
	assert.equal(renders, 1, "model_select should request an immediate footer render");
	assert.equal(quotaForActiveModel().remainingPercent, 98, "second provider must read its own quota cache");
	assert.equal(getRoutingProviderForStatusline("openai-codex-second"), "openai-codex");

	unbind();
	state.set({ provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 400_000 });
	assert.equal(renders, 1, "disposed footer must not receive render requests");
	console.log("✓ model_select immediately switches WEEK 76% → 98% and follows the primary route");
} finally {
	rmSync(agentDir, { recursive: true, force: true });
}

const statusSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const weeklySource = readFileSync(new URL("../weekly-usage-status/index.ts", import.meta.url), "utf8");
assert.match(statusSource, /activeModel\.set\(event\.model\)/);
assert.match(statusSource, /activeModel\.get\(\) \?\? ctx\.model/);
assert.match(statusSource, /getRoutingProviderForStatusline\(provider\)/);
assert.match(weeklySource, /"--provider", provider/);
assert.match(weeklySource, /getCodexProviderId/);
console.log("✓ production statusline and weekly usage handlers use the active provider");
