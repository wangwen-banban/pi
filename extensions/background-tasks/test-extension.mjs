import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

let harnessSequence = 0;

async function harness(t, options = {}) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pi-background-extension-"));
	if (!options.root) t.after(() => rmSync(root, { recursive: true, force: true }));
	const wrapperPath = join(root, `background-test-wrapper-${++harnessSequence}.ts`);
	writeFileSync(wrapperPath, [
		`import { createBackgroundTasksExtension } from ${JSON.stringify(extensionIndexPath)};`,
		`export default createBackgroundTasksExtension({ runsDir: ${JSON.stringify(join(root, "runs"))}, completionDebounceMs: 0, completedTaskHoldMs: 30 });`,
		"",
	].join("\n"));

	const entries = options.entries ?? [];
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
			getSessionId: () => options.sessionId ?? "session-test",
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
	assert.equal(h.messages.length, 0, "low-level agent_end may still retry and is not a safe wake boundary");
	await h.fire("agent_settled");
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

	// After integrating the result, the model can omit irrelevant terminal work
	// from the current-goal plan instead of the extension forcing history back in.
	const reconciled = await execute(update, {
		baseRevision: 4,
		explanation: "benchmark outcome integrated; continue current goal",
		tasks: [
			{ id: "report", title: "Publish quick report", status: "pending" },
			{ id: "analyze", title: "Analyze results", status: "pending" },
		],
	}, h.ctx);
	assert.equal(reconciled.details.plan.tasks.some((task) => task.id === "benchmark"), false);
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
	await h.fire("agent_settled");
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
	const resumed = await harness(t, { root: h.root, entries: h.entries });
	await resumed.fire("session_start", { reason: "reload" });
	await sleep(30);
	assert.equal(resumed.messages.length, 0, "intentional shutdown results must not be replayed as completions");
	const resumedPlan = [...h.entries].reverse().find((entry) => entry.customType === "background-task-plan-v1").data;
	assert.equal(resumedPlan.revision, latestPlan.revision, "blocked shutdown result must not be re-finalized on every restart");
	await resumed.fire("session_shutdown", { reason: "quit" });
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

test("durable terminal wake replays after restart, uses the latest plan revision, and acknowledges exactly once", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const root = mkdtempSync(join(tmpdir(), "pi-background-restart-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runId = "bg-recovered-1";
	const runDir = join(root, "runs", "session-test", runId);
	const resultPath = join(runDir, "result.json");
	mkdirSync(runDir, { recursive: true });
	writeFileSync(resultPath, `${JSON.stringify({
		recordVersion: 2,
		id: runId,
		taskId: "benchmark",
		name: "benchmark",
		status: "completed",
		cwd: root,
		createdAt: 10,
		startedAt: 10,
		finishedAt: 20,
		timeoutAt: 10_000,
		exitCode: 0,
		terminationReason: "completed",
		stdoutTail: "recovered score=42",
		stderrTail: "",
		stdoutPath: join(runDir, "stdout.log"),
		stderrPath: join(runDir, "stderr.log"),
		resultPath,
		logTruncated: false,
	})}\n`);
	const entries = [{
		type: "custom",
		customType: "background-task-plan-v1",
		data: {
			version: 1,
			revision: 7,
			reason: "running before crash",
			updatedAt: 10,
			tasks: [
				{ id: "benchmark", title: "Benchmark", status: "in_progress", updatedAt: 10, runId },
				{ id: "analyze", title: "Analyze", status: "pending", updatedAt: 10 },
				{ id: "report", title: "Report", status: "pending", updatedAt: 10 },
			],
		},
	}];

	const first = await harness(t, { root, entries });
	await first.fire("session_start", { reason: "startup" });
	await waitFor(() => first.messages.length === 1, "recovered terminal result did not wake");
	assert.deepEqual(first.messages[0].message.details.wakeRunIds, [runId]);
	assert.equal(first.messages[0].message.details.plan.revision, 8);
	assert.equal(first.messages[0].message.details.plan.tasks[0].status, "completed");
	assert.match(first.messages[0].message.content, /recovered score=42/);

	// A user revision can race the not-yet-acknowledged wake. Replay must use
	// this newest current-goal order rather than the completion-time order.
	const revised = await execute(first.tools.get("update_task_plan"), {
		baseRevision: 8,
		explanation: "publish before analysis",
		tasks: [
			{ id: "report", title: "Report first", status: "pending" },
			{ id: "analyze", title: "Analyze second", status: "pending" },
		],
	}, first.ctx);
	assert.equal(revised.details.plan.revision, 9);
	await first.fire("session_shutdown", { reason: "reload" });

	const second = await harness(t, { root, entries });
	await second.fire("session_start", { reason: "reload" });
	await waitFor(() => second.messages.length === 1, "pending durable wake was not replayed");
	assert.deepEqual(second.messages[0].message.details.wakeRunIds, [runId]);
	assert.equal(second.messages[0].message.details.plan.revision, 9);
	assert.match(second.messages[0].message.content, /Next pending task from the latest revision: report/);

	// An unrelated successful turn cannot acknowledge a fire-and-forget send
	// that never reached message_start.
	await second.fire("agent_start");
	await second.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
	await second.fire("agent_end", { messages: [] });
	await second.fire("agent_settled");
	assert.equal(entries.some((entry) => entry.customType === "background-task-wake-v1" && entry.data?.state === "acknowledged"), false);

	await second.fire("agent_start");
	await second.fire("message_start", { message: { role: "custom", ...second.messages[0].message } });
	await second.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
	await second.fire("agent_end", { messages: [] });
	await second.fire("agent_settled");
	assert.equal(entries.filter((entry) => entry.customType === "background-task-wake-v1" && entry.data?.state === "acknowledged").length, 1);
	await second.fire("session_shutdown", { reason: "reload" });

	const third = await harness(t, { root, entries });
	await third.fire("session_start", { reason: "reload" });
	await sleep(50);
	assert.equal(third.messages.length, 0, "acknowledged wake must not be delivered again");
	await third.fire("session_shutdown", { reason: "quit" });
});

test("restart without a terminal result fails closed instead of leaving an orphaned plan in progress", async (t) => {
	const previousWeb = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previousWeb === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWeb;
	});
	const entries = [{
		type: "custom",
		customType: "background-task-plan-v1",
		data: {
			version: 1,
			revision: 3,
			reason: "runtime disappeared",
			updatedAt: 10,
			tasks: [{ id: "remote", title: "Watch remote work", status: "in_progress", updatedAt: 10, runId: "bg-lost-owner" }],
		},
	}];
	const h = await harness(t, { entries });
	await h.fire("session_start", { reason: "startup" });
	await waitFor(() => h.messages.length === 1, "lost monitor ownership did not wake recovery");
	const recovered = h.messages[0].message.details.runs[0];
	assert.equal(recovered.status, "failed");
	assert.equal(recovered.terminationReason, "monitor_restarted");
	assert.match(recovered.error, /cannot be safely reattached/);
	assert.equal(h.messages[0].message.details.plan.tasks[0].status, "failed");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("explicit stop reaches a terminal state and uses the ordinary durable wake path", async (t) => {
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
		tasks: [{ id: "watch", title: "Watch", status: "pending" }],
	}, h.ctx);
	await h.fire("agent_start");
	await execute(h.tools.get("run_background_task"), {
		taskId: "watch",
		command: "while :; do sleep 1; done",
	}, h.ctx);
	await execute(h.tools.get("stop_background_task"), { id: "watch" }, h.ctx);
	await waitFor(() => h.lifecycle.some((event) => event.event === "background-task:stopped"), "stop did not become terminal");
	await h.fire("agent_end", { messages: [] });
	await h.fire("agent_settled");
	await waitFor(() => h.messages.length === 1, "explicit stop did not wake");
	assert.equal(h.messages[0].message.details.runs[0].terminationReason, "explicit_stop");
	assert.equal(h.messages[0].message.details.plan.tasks[0].status, "cancelled");
	await h.fire("session_shutdown", { reason: "quit" });
});
