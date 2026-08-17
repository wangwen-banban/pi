import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBusModule = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const extensionIndexPath = fileURLToPath(new URL("./index.ts", import.meta.url));

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail(message);
}

async function harness(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-background-extension-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const wrapperPath = join(root, "background-test-wrapper.ts");
	writeFileSync(wrapperPath, [
		`import { createBackgroundTasksExtension } from ${JSON.stringify(extensionIndexPath)};`,
		`export default createBackgroundTasksExtension({ runsDir: ${JSON.stringify(join(root, "runs"))}, completionDebounceMs: 0, completedTaskHoldMs: 30 });`,
		"",
	].join("\n"));

	const entries = [];
	const messages = [];
	const lifecycle = [];
	const notifications = [];
	const widgets = new Map();
	const statuses = new Map();
	const runtime = loader.createExtensionRuntime();
	runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
	runtime.sendMessage = (message, options) => messages.push({ message, options });
	const eventBus = eventBusModule.createEventBus();
	for (const event of ["started", "progress", "completed", "failed", "stopped"]) {
		eventBus.on(`background-task:${event}`, (payload) => lifecycle.push({ event: `background-task:${event}`, payload }));
	}
	const loaded = await loader.loadExtensions([wrapperPath], root, eventBus, runtime);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const handlers = extension.handlers;
	const tools = new Map([...extension.tools].map(([name, entry]) => [name, entry.definition]));
	const commands = extension.commands;
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: false,
		sessionManager: {
			getSessionId: () => "session-test",
			getBranch: () => entries,
		},
		ui: {
			notify(message, kind) { notifications.push({ message, kind }); },
			setWidget(key, lines) { widgets.set(key, lines); },
			setStatus(key, value) { statuses.set(key, value); },
			theme: { fg(_tone, text) { return text; } },
		},
	};
	async function fire(event, payload = {}) {
		let result;
		for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
		return result;
	}
	return { root, handlers, tools, commands, entries, messages, lifecycle, notifications, widgets, statuses, ctx, fire };
}

async function execute(tool, params, ctx) {
	return tool.execute("tool-call", params, undefined, undefined, ctx);
}

test("dynamic prompt updates survive a running command and completion wakes the main agent with latest next task", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	const update = h.tools.get("update_task_plan");
	const run = h.tools.get("run_background_task");
	assert.ok(update && run);

	let result = await execute(update, {
		baseRevision: 0,
		explanation: "initial user request",
		tasks: [
			{ id: "benchmark", title: "Run benchmark", status: "pending" },
			{ id: "analyze", title: "Analyze results", status: "pending" },
		],
	}, h.ctx);
	assert.equal(result.details.plan.revision, 1);

	await h.fire("agent_start");
	result = await execute(run, {
		taskId: "benchmark",
		name: "benchmark",
		command: "sleep 0.15; printf '\\033[31mscore=42\\033[0m\\n'",
		timeoutMs: 2_000,
	}, h.ctx);
	assert.equal(result.details.plan.revision, 2);
	assert.equal(result.details.run.status, "running");

	// A new user prompt changes the pending order while the benchmark continues.
	result = await execute(update, {
		baseRevision: 2,
		explanation: "user asked to publish before deeper analysis",
		tasks: [
			{ id: "benchmark", title: "Run benchmark", status: "in_progress" },
			{ id: "report", title: "Publish quick report", status: "pending" },
			{ id: "analyze", title: "Analyze results", status: "pending" },
		],
	}, h.ctx);
	assert.equal(result.details.plan.revision, 3);

	await waitFor(
		() => h.lifecycle.some((event) => event.event === "background-task:completed"),
		"background completion event was not emitted",
	);
	assert.equal(h.messages.length, 0, "completion must wait while the parent agent is active");
	await h.fire("agent_end");
	await waitFor(() => h.messages.length === 1, "main-agent wake was not delivered");
	const wake = h.messages[0];
	assert.equal(wake.options.triggerTurn, true);
	assert.equal(wake.options.deliverAs, "followUp");
	assert.match(wake.message.content, /score=42/);
	assert.equal(wake.message.content.includes("\u001b"), false, "completion message must strip terminal control sequences");
	assert.match(wake.message.content, /Task plan revision 4/);
	assert.match(wake.message.content, /Next pending task from the latest revision: report/);
	assert.equal(wake.message.details.plan.tasks.find((task) => task.id === "benchmark").status, "completed");
	assert.equal(wake.message.details.plan.tasks[1].id, "report");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("non-zero exit also wakes the main agent and marks the linked task failed", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		tasks: [{ id: "build", title: "Build", status: "pending" }],
	}, h.ctx);
	await h.fire("agent_start");
	await execute(h.tools.get("run_background_task"), {
		taskId: "build",
		command: "printf 'compile failed\\n' >&2; exit 9",
	}, h.ctx);
	await waitFor(() => h.lifecycle.some((event) => event.event === "background-task:failed"), "failure hook missing");
	await h.fire("agent_end");
	await waitFor(() => h.messages.length === 1, "failure did not wake main agent");
	assert.match(h.messages[0].message.content, /Background task failed/);
	assert.match(h.messages[0].message.content, /compile failed/);
	assert.equal(h.messages[0].message.details.plan.tasks[0].status, "failed");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("active background task blocks branch changes and shutdown marks it blocked without waking", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		tasks: [{ id: "long", title: "Long command", status: "pending" }],
	}, h.ctx);
	await h.fire("agent_start");
	await execute(h.tools.get("run_background_task"), {
		taskId: "long",
		command: "while :; do sleep 1; done",
	}, h.ctx);
	assert.deepEqual(await h.fire("session_before_tree", { preparation: {}, signal: new AbortController().signal }), { cancel: true });
	await h.fire("session_shutdown", { reason: "reload" });
	assert.equal(h.messages.length, 0);
	const latestPlan = [...h.entries].reverse().find((entry) => entry.customType === "background-task-plan-v1").data;
	assert.equal(latestPlan.tasks[0].status, "blocked");
});

test("TUI widget keeps pending, in-progress and completed work visible", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const h = await harness(t);
	h.ctx.hasUI = true;
	await h.fire("session_start", { reason: "startup" });
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		tasks: [
			{ id: "done", title: "Finished work", status: "completed" },
			{ id: "current", title: "Current work", status: "in_progress" },
			{ id: "next", title: "Next work", status: "pending" },
		],
	}, h.ctx);
	const lines = h.widgets.get("background-tasks");
	assert.match(lines.join("\n"), /Tasks · revision 1/);
	assert.match(lines.join("\n"), /✓ done/);
	assert.match(lines.join("\n"), /▶ current/);
	assert.match(lines.join("\n"), /○ next/);
	assert.match(h.statuses.get("background-tasks"), /1 pending/);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("expired completed row leaves the compact widget and truncated pending work moves up", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const h = await harness(t);
	h.ctx.hasUI = true;
	await h.fire("session_start", { reason: "startup" });
	const pending = Array.from({ length: 12 }, (_, index) => ({
		id: `pending-${String(index).padStart(2, "0")}`,
		title: `Pending ${index}`,
		status: "pending",
	}));
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		tasks: [{ id: "recent-done", title: "Recently done", status: "completed" }, ...pending],
	}, h.ctx);
	assert.match(h.widgets.get("background-tasks").join("\n"), /recent-done/);
	assert.match(h.widgets.get("background-tasks").join("\n"), /… 1 more/);
	await waitFor(() => {
		const text = (h.widgets.get("background-tasks") ?? []).join("\n");
		return !text.includes("recent-done") && text.includes("pending-11") && !text.includes("… 1 more");
	}, "completed task did not age out of the compact widget");
	const stored = [...h.entries].reverse().find((entry) => entry.customType === "background-task-plan-v1").data;
	assert.equal(stored.tasks.length, 13, "display expiry must not delete task history");
	assert.equal(stored.tasks[0].status, "completed");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("system prompt always carries the latest dynamic revision", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		explanation: "new prompt",
		tasks: [{ id: "one", title: "One", status: "pending" }],
	}, h.ctx);
	const result = await h.fire("before_agent_start", { systemPrompt: "BASE" });
	assert.match(result.systemPrompt, /^BASE/);
	assert.match(result.systemPrompt, /Task plan revision 1/);
	assert.match(result.systemPrompt, /User prompts may change scope/);
	await h.fire("session_shutdown", { reason: "quit" });
});
