import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { collectParentMessages, serializeMessages } from "./context.ts";
import { DEFAULT_CONFIG } from "./router.ts";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const bus = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const { SessionManager } = await import(pathToFileURL(join(piRoot, "dist/core/session-manager.js")).href);

// Expose the actual private preparation functions in a temporary test module.
// Production exports, provider calls, process spawning and session files are not changed.
const indexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const root = mkdtempSync(join(tmpdir(), "pi-subagent-context-test-"));
after(() => rmSync(root, { recursive: true, force: true }));
const globalKey = `__piSubagentContextTest_${process.pid}`;
const source = readFileSync(indexPath, "utf8").replace(/from "(\.[^"]+)"/g,
	(_match, relative) => `from ${JSON.stringify(resolve(dirname(indexPath), relative))}`);
const wrapper = join(root, "index.ts");
writeFileSync(wrapper, source + `\n(globalThis as any)[${JSON.stringify(globalKey)}] = { classifyAndSummarize, buildContextPacket };\n`);
const loaded = await loader.loadExtensions([wrapper], root, bus.createEventBus(), loader.createExtensionRuntime());
assert.deepEqual(loaded.errors, []);
const { classifyAndSummarize, buildContextPacket } = globalThis[globalKey];
delete globalThis[globalKey];

const user = (sm, text) => sm.appendMessage({ role: "user", content: text, timestamp: 1 });
const fixtureModel = {
	id: "fixture", name: "fixture", provider: "openai", api: "openai-responses",
	baseUrl: "http://127.0.0.1:1", reasoning: true, input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 1 }, contextWindow: 10000, maxTokens: 1000,
};
function routerHarness(sm = SessionManager.inMemory()) {
	const calls = [];
	let fail = false;
	const config = structuredClone(DEFAULT_CONFIG);
	config.router.model = "openai/fixture";
	config.router.maxConversationChars = 2000;
	const ctx = {
		sessionManager: sm, model: fixtureModel,
		modelRegistry: {
			getAvailable: () => [fixtureModel],
			async complete(model, context, options) {
				calls.push({ model, context, options });
				if (fail) throw new Error("synthetic provider failure");
				return { content: [{ type: "text", text: JSON.stringify({ complexity: "complex", context_mode: "summary",
					permission: "workspace-write", reason: "fixture", context_summary: "Distilled evidence" }) }], usage: { input: 10, output: 5 } };
			},
		},
	};
	return { ctx, sm, config, calls, setFail() { fail = true; } };
}
const fixed = { task: "inspect a file", model: "openai/fixture", effort: "low", contextMode: "selected", permission: "read-only" };

test("Pi: only the latest compaction and its retained suffix reach the worker", () => {
	const sm = SessionManager.inMemory();
	user(sm, "OLD-RAW-CONTENT".repeat(4000));
	const kept = user(sm, "Keep compatibility");
	sm.appendCompaction("Current findings", kept, 60000);
	user(sm, "Newest requirement");
	const text = serializeMessages(collectParentMessages(sm));
	assert.doesNotMatch(text, /OLD-RAW-CONTENT/);
	assert.match(text, /Current findings/);
	assert.match(text, /Keep compatibility/);
	assert.match(text, /Newest requirement/);
	assert.ok(text.length < 300);
});

test("Pi: branch rewind and reset cannot inherit an off-branch constraint", () => {
	const sm = SessionManager.inMemory();
	const branch = user(sm, "A"); user(sm, "B"); sm.branch(branch);
	assert.deepEqual(collectParentMessages(sm), [{ role: "user", text: "A" }]);
	sm.resetLeaf();
	assert.deepEqual(collectParentMessages(sm), []);
});

test("Pi: a kept message is inherited exactly once after compaction", () => {
	const sm = SessionManager.inMemory(); user(sm, "old"); const kept = user(sm, "KEPT");
	sm.appendCompaction("summary", kept, 5000);
	assert.equal(serializeMessages(collectParentMessages(sm)).split("KEPT").length - 1, 1);
});

test("fixed execution choices invoke zero advisor calls without changing the parent", async () => {
	const h = routerHarness(); user(h.sm, "current context");
	const before = JSON.stringify(h.sm.getEntries());
	const result = await classifyAndSummarize(h.ctx, fixed, h.config);
	assert.equal(h.calls.length, 0);
	assert.equal(result.usage, undefined);
	assert.equal(result.decision.contextMode, "selected");
	assert.equal(result.decision.permission, "read-only");
	assert.match(result.decision.reason, /advisor skipped/);
	assert.equal(JSON.stringify(h.sm.getEntries()), before);
});

test("the legacy explicit complexity fast path still invokes zero calls", async () => {
	const h = routerHarness();
	await classifyAndSummarize(h.ctx, { task: "inspect", complexity: "simple", contextMode: "selected", permission: "read-only" }, h.config);
	assert.equal(h.calls.length, 0);
});

test("explicit isolated dispatch never reads or forwards parent history, including to an auto advisor", async () => {
	const h = routerHarness({ buildContextEntries() { throw new Error("must not read isolated parent"); } });
	const result = await classifyAndSummarize(h.ctx, { task: "self-contained", contextMode: "isolated", contextNotes: "explicit note" }, h.config);
	assert.equal(h.calls.length, 1, "unresolved routing still gets the advisor");
	const prompt = h.calls[0].context.messages[0].content[0].text;
	assert.match(prompt, /No parent conversation available/);
	assert.match(prompt, /explicit note/);
	assert.equal(result.decision.contextMode, "isolated");
	assert.deepEqual(result.messages, []);
});

test("summary mode still calls the advisor and preserves explicit read-only permission", async () => {
	const h = routerHarness(); user(h.sm, "evidence");
	const result = await classifyAndSummarize(h.ctx, { ...fixed, contextMode: "summary" }, h.config);
	assert.equal(h.calls.length, 1);
	assert.equal(result.decision.contextSummary, "Distilled evidence");
	assert.equal(result.decision.permission, "read-only", "advisor cannot replace explicit authority");
	assert.equal(result.usage.input, 10);
});

test("auto routing remains enabled when only model and effort are fixed", async () => {
	const h = routerHarness();
	await classifyAndSummarize(h.ctx, { task: "inspect", model: "openai/fixture", effort: "low" }, h.config);
	assert.equal(h.calls.length, 1);
});

test("the advisor gets newest constraints even after a very large assistant response", async () => {
	const h = routerHarness(); user(h.sm, "stale".repeat(5000)); user(h.sm, "DO-NOT-CHANGE-API");
	h.sm.appendMessage({ role: "assistant", content: [{ type: "text", text: "x".repeat(10000) + "RECENT-EVIDENCE" }], timestamp: 2 });
	await classifyAndSummarize(h.ctx, { ...fixed, contextMode: "summary" }, h.config);
	const prompt = h.calls[0].context.messages[0].content[0].text;
	const parent = prompt.split("PARENT CONVERSATION (reference only):\n")[1].split("\nTASK:")[0];
	assert.ok(parent.length <= 2000);
	assert.match(parent, /DO-NOT-CHANGE-API/);
	assert.match(parent, /RECENT-EVIDENCE/);
	assert.doesNotMatch(parent, /stale/);
	assert.ok(prompt.indexOf("PARENT CONVERSATION") < prompt.indexOf("TASK:"));
});

test("advisor failures preserve fallback and explicit choices; no retry is added", async () => {
	const h = routerHarness(); h.setFail();
	const result = await classifyAndSummarize(h.ctx, { ...fixed, contextMode: "summary" }, h.config);
	assert.equal(h.calls.length, 1);
	assert.equal(result.decision.contextSummary, "");
	assert.equal(result.decision.permission, "read-only");
	assert.equal(result.decision.contextMode, "summary");
});

test("a failed effective context read makes no provider call", async () => {
	const h = routerHarness({ buildContextEntries() { throw new Error("effective context unavailable"); } });
	await assert.rejects(classifyAndSummarize(h.ctx, fixed, h.config), /effective context unavailable/);
	assert.equal(h.calls.length, 0);
});

function job(overrides = {}) {
	return { name: "name-a", id: "id-a", route: { ...fixed, provider: "fixture", modelId: "model-a", contextSummary: "",
		complexity: "simple", reason: "reason-a" }, config: structuredClone(DEFAULT_CONFIG), contextFiles: ["src/a.ts"],
		writeScope: ["src/a.ts"], ...overrides };
}
const evidence = [{ role: "user", text: "shared evidence" }];
const packet = (value, messages = evidence, notes = "explicit requirements") => buildContextPacket(value, messages, notes);

test("worker packet no longer varies with operational ID, name, model or routing explanation", () => {
	const a = job();
	const b = job({ name: "name-b", id: "id-b", route: { ...a.route, modelId: "model-b", effort: "max", reason: "reason-b", complexity: "critical" } });
	assert.equal(packet(a), packet(b));
	assert.doesNotMatch(packet(a), /id-a|name-a|model-a|reason-a|Effective route/);
});

test("permission and scope remain ahead of context, with files and notes still present", () => {
	const text = packet(job());
	assert.match(text, /You are read-only/);
	assert.match(text, /Do not delegate/);
	assert.ok(text.indexOf("Allowed write scope") < text.indexOf("Parent context"));
	assert.ok(text.indexOf("Parent context") < text.indexOf("Relevant files"));
	assert.match(text, /src\/a.ts/);
	assert.match(text, /explicit requirements/);
	const writable = job(); writable.route.permission = "workspace-write";
	assert.match(packet(writable), /only within the declared write scope/);
	assert.notEqual(packet(writable), text, "authority changes must not be hidden for cache hits");
});

test("isolated worker packet omits parent text but preserves notes and scope", () => {
	const value = job(); value.route.contextMode = "isolated";
	const text = packet(value);
	assert.doesNotMatch(text, /shared evidence/);
	assert.match(text, /No parent conversation was inherited/);
	assert.match(text, /explicit requirements/);
	assert.match(text, /src\/a.ts/);
});

test("selected, summary fallback and full modes keep their existing character budgets", () => {
	const messages = [{ role: "user", text: "REQUIRED" }, { role: "assistant", text: "z".repeat(10000) + "LAST" }];
	for (const mode of ["selected", "summary", "full"]) {
		const value = job(); value.route.contextMode = mode;
		value.config.context.maxSelectedChars = 2000; value.config.context.maxFullChars = 4000;
		const text = packet(value, messages);
		assert.match(text, /REQUIRED/); assert.match(text, /LAST/);
		assert.ok(text.length < (mode === "full" ? 5000 : 3000));
	}
});

test("a supplied summary is not replaced by copied conversation", () => {
	const value = job(); value.route.contextMode = "summary"; value.route.contextSummary = "chosen summary";
	assert.match(packet(value), /chosen summary/);
	assert.doesNotMatch(packet(value), /shared evidence/);
});
