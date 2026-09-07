import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const { createExtensionRuntime, loadExtensions } = await import(
	pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href
);
const { createEventBus } = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

async function harness() {
	const entries = [];
	const choices = [];
	const calls = { custom: 0, confirm: 0, input: 0 };
	const runtime = createExtensionRuntime();
	runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
	const loaded = await loadExtensions([extensionPath], process.cwd(), createEventBus(), runtime);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const tools = new Map([...extension.tools].map(([name, entry]) => [name, entry.definition]));
	const ctx = {
		cwd: process.cwd(), mode: "tui", hasUI: true,
		sessionManager: {
			getSessionId: () => "autonomy-test-session",
			getBranch: () => entries,
			buildContextEntries: () => entries,
		},
		ui: {
			theme: { fg: (_tone, text) => text },
			notify() {}, setStatus() {}, setWidget() {}, setWorkingVisible() {},
			async custom() { calls.custom++; return choices.length ? choices.shift() : null; },
			async confirm() { calls.confirm++; return false; },
			async input() { calls.input++; return undefined; },
		},
	};
	return {
		tools, ctx, entries, calls, choices,
		async fire(name, payload = {}) {
			let result;
			for (const handler of extension.handlers.get(name) ?? []) {
				result = await handler({ type: name, ...payload }, ctx);
			}
			return result;
		},
		async execute(name, params = {}) {
			return tools.get(name).execute("test-call", params, undefined, undefined, ctx);
		},
	};
}
const textOf = (result) => result.content[0].text;
const policyOf = (tool) => [tool.description, tool.promptSnippet, ...(tool.promptGuidelines ?? [])].join("\n");

test("runtime prompts set a zero-routine-question default with an evidence-first decision boundary", async () => {
	const h = await harness();
	const enter = policyOf(h.tools.get("enter_plan_mode"));
	const ask = policyOf(h.tools.get("ask_user"));
	assert.match(enter, /zero decision prompts/);
	assert.match(enter, /reasonable investigation cannot resolve it/);
	assert.match(enter, /no safe, reversible default/);
	assert.match(enter, /Explicit ask-first instructions and mandatory approvals take precedence/);
	assert.match(ask, /search terms, source order, paper-reading depth, report layout/);
	assert.match(ask, /Batch related decisions/);
	assert.match(ask, /Do not ask again about an answered question/);
	assert.match(ask, /Unspecified budgets are not permission/);
	assert.match(ask, /publication, or disclosure of private data/);
});

test("decision questions are not a mandatory enter/ask/exit approval pipeline", async () => {
	const h = await harness();
	assert.match(policyOf(h.tools.get("ask_user")), /Works outside Plan Mode/);
	assert.match(policyOf(h.tools.get("ask_user")), /Do not enter Plan Mode just to ask a question/);
	assert.match(policyOf(h.tools.get("exit_plan_mode")), /only when Plan Mode is already active/);
	const agents = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");
	assert.match(agents, /zero decision prompts/);
	assert.match(agents, /all three/);
	assert.match(agents, /cancellation is not consent/i);
});

test("ordinary turns and context snapshots do not themselves open approval UI or activate the gate", async () => {
	const h = await harness();
	for (let i = 0; i < 40; i++) {
		await h.fire("turn_start");
		const result = await h.fire("before_agent_start", { systemPrompt: "stable" });
		assert.equal(result.systemPrompt, undefined);
		if (result.message) h.entries.push({ type: "custom_message", ...result.message });
	}
	assert.deepEqual(h.calls, { custom: 0, confirm: 0, input: 0 });
	assert.equal(h.entries.filter(e => e.type === "custom").length, 0);
	assert.equal((await h.fire("tool_call", { toolName: "edit", input: {} })).block, false);
});

test("a necessary decision remains available outside Plan Mode without changing permissions", async () => {
	const h = await harness();
	h.choices.push({ answer: "Keep private", wasCustom: false, index: 1 });
	const result = await h.execute("ask_user", {
		question: "Should the requested report remain private or be published? Recommendation: keep private.",
		options: [{ label: "Keep private" }, { label: "Publish after review" }],
	});
	assert.match(textOf(result), /Keep private/);
	assert.equal(h.calls.custom, 1);
	assert.equal(h.entries.length, 0);
});

test("cancelling a decision discourages a repeated question and never changes gate state", async () => {
	const h = await harness();
	const result = await h.execute("ask_user", {
		question: "Choose an authorized budget", options: [{ label: "Existing budget" }, { label: "Request an increase" }],
	});
	assert.match(textOf(result), /不要立即重复提问/);
	assert.match(textOf(result), /不要把取消当作授权/);
	assert.equal(h.calls.custom, 1);
	assert.equal(h.entries.length, 0);
});

test("explicit Plan Mode still blocks writes and forces delegated work to read-only", async () => {
	const h = await harness();
	await h.execute("enter_plan_mode", { reason: "user requested approval before production changes" });
	for (const toolName of ["edit", "write", "run_background_task"]) {
		assert.equal((await h.fire("tool_call", { toolName, input: {} })).block, true);
	}
	assert.equal((await h.fire("tool_call", { toolName: "bash", input: { command: "rm -rf important-data" } })).block, true);
	assert.equal((await h.fire("tool_call", { toolName: "bash", input: { command: "git status" } })).block, false);
	const input = { permission: "workspace-write", writeScope: ["."] };
	await h.fire("tool_call", { toolName: "delegate_subagent", input });
	assert.equal(input.permission, "read-only");
	assert.deepEqual(input.writeScope, []);
});

test("cancelled plan approval keeps writes blocked and does not recommend a follow-up selection", async () => {
	const h = await harness();
	await h.execute("enter_plan_mode", { reason: "user asked to review first" });
	const result = await h.execute("exit_plan_mode", { plan: "Review the change before implementation" });
	assert.match(textOf(result), /no approval was granted/);
	assert.match(textOf(result), /Do not immediately reopen/);
	assert.doesNotMatch(textOf(result), /ask_user for clarification/);
	assert.equal((await h.fire("tool_call", { toolName: "write", input: {} })).block, true);
	assert.deepEqual(h.calls, { custom: 1, confirm: 0, input: 0 });
});

test("one explicit approval covers in-scope phases without weakening later approval boundaries", async () => {
	const h = await harness();
	await h.execute("enter_plan_mode", { reason: "approval required" });
	h.choices.push("approve");
	const result = await h.execute("exit_plan_mode", { plan: "Implement, test, and validate the scoped change" });
	assert.match(textOf(result), /without re-asking at each phase/);
	assert.match(textOf(result), /outside this scope still require permission/);
	for (const toolName of ["edit", "write", "run_background_task"]) {
		assert.equal((await h.fire("tool_call", { toolName, input: {} })).block, false);
	}
	await h.execute("exit_plan_mode", { plan: "routine follow-up" });
	assert.equal(h.calls.custom, 1, "inactive exit must not open another dialog");
	await h.execute("enter_plan_mode", { reason: "new high-risk commitment outside previous scope" });
	assert.equal((await h.fire("tool_call", { toolName: "write", input: {} })).block, true);
});

test("headless execution still cannot auto-approve an active gate", async () => {
	const h = await harness();
	await h.execute("enter_plan_mode", { reason: "requires user approval" });
	h.ctx.mode = "print";
	await h.execute("exit_plan_mode", { plan: "must not silently approve" });
	assert.equal((await h.fire("tool_call", { toolName: "edit", input: {} })).block, true);
	assert.deepEqual(h.calls, { custom: 0, confirm: 0, input: 0 });
});
