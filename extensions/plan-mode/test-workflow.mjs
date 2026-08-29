import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBusModule = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const extensionIndexPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const agentsPath = fileURLToPath(new URL("../../AGENTS.md", import.meta.url));

async function harness(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-mode-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const wrapperPath = join(root, "plan-mode-test-wrapper.ts");
	writeFileSync(wrapperPath, `export { default } from ${JSON.stringify(extensionIndexPath)};\n`);

	const entries = [];
	const notifications = [];
	const statuses = new Map();
	const uiCalls = { custom: 0, confirm: 0, input: 0 };
	const customResults = [];
	const runtime = loader.createExtensionRuntime();
	runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
	const loaded = await loader.loadExtensions(
		[wrapperPath],
		root,
		eventBusModule.createEventBus(),
		runtime,
	);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const tools = new Map([...extension.tools].map(([name, entry]) => [name, entry.definition]));
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "plan-mode-test-session",
			getBranch: () => entries,
		},
		ui: {
			async custom() {
				uiCalls.custom += 1;
				return customResults.shift() ?? null;
			},
			async confirm() {
				uiCalls.confirm += 1;
				return false;
			},
			async input() {
				uiCalls.input += 1;
				return undefined;
			},
			notify(message, kind) { notifications.push({ message, kind }); },
			setStatus(key, value) { statuses.set(key, value); },
			theme: { fg(_tone, text) { return text; } },
		},
	};

	async function fire(event, payload = {}) {
		let result;
		for (const handler of extension.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload }, ctx);
		}
		return result;
	}

	return {
		ctx,
		entries,
		fire,
		notifications,
		queueCustom: (...values) => customResults.push(...values),
		statuses,
		tools,
		uiCalls,
	};
}

async function execute(tool, params, ctx) {
	assert.ok(tool, "expected registered tool");
	return tool.execute("test-call", params, undefined, undefined, ctx);
}

function resultText(result) {
	const part = result?.content?.[0];
	return part?.type === "text" ? part.text : "";
}

test("balanced policy removes blanket triggers and enter_plan_mode is sequential", async (t) => {
	const h = await harness(t);
	const enter = h.tools.get("enter_plan_mode");
	assert.equal(enter.executionMode, "sequential");

	const guidelines = enter.promptGuidelines.join("\n");
	const agents = readFileSync(agentsPath, "utf8");
	for (const policy of [guidelines, agents]) {
		assert.doesNotMatch(policy, /non-trivial|>2 files/i);
		assert.doesNotMatch(policy, /After errors or unexpected results/i);
		assert.doesNotMatch(policy, /Do NOT skip planning for tasks touching >2 files/i);
		assert.match(policy, /multiple files/i);
		assert.match(policy, /test(?:\s*,\s*|\/)build/i);
		assert.match(policy, /same top-level goal/i);
		assert.match(policy, /do not re-enter/i);
	}
	assert.match(guidelines, /are NOT reasons to enter Plan Mode/i);
	assert.match(guidelines, /ask_user is optional/i);
	assert.match(agents, /do not by themselves justify Plan Mode/i);
});

test("exit_plan_mode while inactive is a UI-free no-op in TUI and RPC", async (t) => {
	const h = await harness(t);
	const exit = h.tools.get("exit_plan_mode");

	let result = await execute(exit, { plan: "unused" }, h.ctx);
	assert.match(resultText(result), /not active/i);
	assert.match(resultText(result), /No approval UI was opened/i);

	h.ctx.mode = "rpc";
	result = await execute(exit, { plan: "still unused" }, h.ctx);
	assert.match(resultText(result), /not active/i);
	assert.deepEqual(h.uiCalls, { custom: 0, confirm: 0, input: 0 });
	assert.equal(h.entries.length, 0, "inactive exit must not append a state marker");
});

test("a clear plan can enter and exit with only the final approval", async (t) => {
	const h = await harness(t);
	const enter = h.tools.get("enter_plan_mode");
	const exit = h.tools.get("exit_plan_mode");

	await execute(enter, { reason: "user requested a plan" }, h.ctx);
	h.queueCustom("approve");
	const result = await execute(exit, { plan: "1. Make the approved change\n2. Test it" }, h.ctx);

	assert.match(resultText(result), /APPROVED/);
	assert.deepEqual(h.uiCalls, { custom: 1, confirm: 0, input: 0 });
	assert.deepEqual(h.entries.map((entry) => entry.data.state), ["active", "inactive"]);
	assert.deepEqual(
		await h.fire("tool_call", { toolName: "edit", input: {} }),
		{ block: false },
		"approval must unblock implementation without an ask_user call",
	);
});

test("rejection and feedback remain active and reuse exit_plan_mode", async (t) => {
	const h = await harness(t);
	const enter = h.tools.get("enter_plan_mode");
	const exit = h.tools.get("exit_plan_mode");

	await execute(enter, { reason: "user requested a plan" }, h.ctx);
	h.queueCustom("reject", { feedback: "keep the public API unchanged" });

	let result = await execute(exit, { plan: "First proposal" }, h.ctx);
	assert.match(resultText(result), /REJECTED/);
	assert.equal((await h.fire("tool_call", { toolName: "edit", input: {} })).block, true);

	result = await execute(exit, { plan: "Revised proposal" }, h.ctx);
	assert.match(resultText(result), /provided feedback/);
	assert.equal((await h.fire("tool_call", { toolName: "write", input: {} })).block, true);
	assert.equal(h.uiCalls.custom, 2, "both revisions use exit_plan_mode without another enter");
	assert.deepEqual(h.entries.map((entry) => entry.data.state), ["active"]);
});
