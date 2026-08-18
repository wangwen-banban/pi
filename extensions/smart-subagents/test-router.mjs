import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	THINKING_LEVELS,
	buildModelListText,
	formatThinkingLevels,
	mergeConfig,
	paginateModels,
	recentMessages,
	resolveModelProfile,
} from "./router.ts";

function descriptor(ref, tier, overrides = {}) {
	const [provider, ...idParts] = ref.split("/");
	return {
		ref,
		provider,
		providerName: `${provider} Cloud`,
		id: idParts.join("/"),
		name: idParts.join("/"),
		current: false,
		tier,
		tierSource: "configured",
		note: "",
		thinkingLevels: ["low", "medium", "high"],
		contextWindow: 128_000,
		maxTokens: 16_000,
		costInput: 1,
		costOutput: 4,
		costTiered: false,
		...overrides,
	};
}

test("resolveModelProfile distinguishes configured and neutral-default tiers", () => {
	const profiles = {
		defaultTier: "B",
		models: {
			"provider/strong": { tier: "S", note: "High-risk work" },
		},
	};
	assert.deepEqual(resolveModelProfile(profiles, "provider/strong"), {
		tier: "S",
		tierSource: "configured",
		note: "High-risk work",
	});
	assert.deepEqual(resolveModelProfile(profiles, "provider/unprofiled"), {
		tier: "B",
		tierSource: "default",
		note: "",
	});
});

test("mergeConfig merges profiles, execution limits, context, and legacy routes", () => {
	const merged = mergeConfig({
		context: { selectedMessages: 500 },
		execution: { hardTimeoutMs: 30_000, terminateGraceMs: 90_000 },
		modelProfiles: {
			defaultTier: "A",
			models: {
				"provider/budget": { tier: "C", note: "  inexpensive  " },
				"provider/invalid": { tier: "Z", note: "ignored" },
			},
		},
		routes: {
			medium: { models: ["legacy/model"], effort: "high", context: "full" },
		},
	});
	assert.equal(merged.context.selectedMessages, 50);
	assert.equal(mergeConfig({ context: { selectedMessages: 0 } }).context.selectedMessages, 1);
	assert.equal(merged.execution.hardTimeoutMs, 60_000);
	assert.equal(merged.execution.terminateGraceMs, 60_000);
	assert.equal(mergeConfig({}).execution.hardTimeoutMs, 30 * 60_000);
	assert.equal(merged.modelProfiles.defaultTier, "A");
	assert.deepEqual(merged.modelProfiles.models["provider/budget"], {
		tier: "C",
		note: "inexpensive",
	});
	assert.equal(merged.modelProfiles.models["provider/invalid"], undefined);
	assert.deepEqual(merged.routes.medium, {
		models: ["legacy/model"],
		effort: "high",
		context: "full",
	});
});

test("recentMessages takes the ordered tail", () => {
	const messages = [
		{ role: "user", text: "one" },
		{ role: "assistant", text: "two" },
		{ role: "user", text: "three" },
		{ role: "assistant", text: "four" },
	];
	assert.deepEqual(recentMessages(messages, 2), messages.slice(2));
	assert.deepEqual(recentMessages(messages, 10), messages);
	assert.deepEqual(recentMessages(messages, 0), []);
});

test("formatThinkingLevels renders all, ranges, one level, and unknown", () => {
	assert.equal(formatThinkingLevels([...THINKING_LEVELS]), "all");
	assert.equal(formatThinkingLevels(["low", "medium", "high", "xhigh", "max"]), "low..max");
	assert.equal(formatThinkingLevels(["high"]), "high");
	assert.equal(formatThinkingLevels([]), "?");
});

test("paginateModels filters by tier and text, then paginates with continuation metadata", () => {
	const models = [
		descriptor("alpha/sol", "S", { name: "Solar", note: "deep reasoning" }),
		descriptor("beta/general", "B", { name: "General Coder" }),
		descriptor("gamma/budget", "C", { note: "budget fast path" }),
		descriptor("delta/reviewer", "B", { providerName: "Review Cloud" }),
	];

	const tierPage = paginateModels(models, { tier: "B", maxRows: 10, offset: 0 });
	assert.deepEqual(tierPage.descriptors.map((model) => model.ref), ["beta/general", "delta/reviewer"]);
	assert.equal(tierPage.result.matched, 2);

	const filtered = paginateModels(models, { filter: "BUDGET", maxRows: 10, offset: 0 });
	assert.deepEqual(filtered.descriptors.map((model) => model.ref), ["gamma/budget"]);

	const page = paginateModels(models, { maxRows: 2, offset: 1 });
	assert.deepEqual(page.descriptors.map((model) => model.ref), ["beta/general", "gamma/budget"]);
	assert.deepEqual(page.result, {
		matched: 4,
		shown: 2,
		offset: 1,
		nextOffset: 3,
		truncated: true,
	});
});

test("buildModelListText includes catalogue disclaimers, default-tier marker, and continuation", () => {
	const model = descriptor("provider/unprofiled", "B", {
		tierSource: "default",
		thinkingLevels: [...THINKING_LEVELS],
	});
	const text = buildModelListText(
		[model],
		{ matched: 3, shown: 1, offset: 0, nextOffset: 1, truncated: true },
		"session",
	);
	assert.match(text, /Eligible sub-agent models: 3 · showing 1 · scope: session/);
	assert.match(text, /curated capability guidance, not a benchmark/);
	assert.match(text, /registry USD per 1M tokens/);
	assert.match(text, /B\*/);
	assert.match(text, /Call again with offset=1/);
});

test("smart-subagents index wires informed model routing and removes context-file coupling", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /list_subagent_models/);
	assert.match(source, /getEligibleModels/);
	assert.match(source, /selectedMessages/);
	assert.match(source, /background advisor skipped/);
	assert.match(source, /recentMessages\(messages/);
	assert.match(source, /createActivityRefreshLoop/);
	assert.match(source, /child\.on\("close", \(code, signal\)/);
	assert.match(source, /createExecutionTimeout/);
	assert.match(source, /shutdownJobs\(jobs\.values\(\)/);
	assert.match(source, /read,grep,find,ls,web_search/);
	assert.match(source, /read,bash,edit,write,grep,find,ls,web_search/);
	assert.doesNotMatch(source, /params\.contextFiles.*selected/);
});
