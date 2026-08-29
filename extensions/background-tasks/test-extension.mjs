import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { durableTaskPlanMarker, TASK_PLAN_MARKER_TYPE } from "./plan-state.ts";
import {
	BACKGROUND_RUN_RECORD_VERSION,
	prepareSecureRunDirectory,
	writeTerminalRunManifest,
} from "./run-persistence.ts";
import {
	BACKGROUND_WAKE_MARKER_TYPE,
	pendingWakeMarker,
} from "./wake-state.ts";

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
		await sleep(5);
	}
	assert.fail(message);
}

class FakeWakeRetryScheduler {
	tasks = new Map();
	delays = [];
	nextId = 1;
	setTimeout(callback, delayMs) {
		const handle = { id: this.nextId++, unref() {} };
		this.tasks.set(handle, callback);
		this.delays.push(delayMs);
		return handle;
	}
	clearTimeout(handle) { this.tasks.delete(handle); }
	runNext() {
		const next = this.tasks.entries().next();
		assert.equal(next.done, false, "expected a scheduled wake retry");
		const [handle, callback] = next.value;
		this.tasks.delete(handle);
		callback();
	}
	get pendingCount() { return this.tasks.size; }
}

let harnessSequence = 0;

async function harness(t, options = {}) {
	const root = options.root ?? mkdtempSync(join(tmpdir(), "pi-background-extension-"));
	if (!options.root) t.after(() => rmSync(root, { recursive: true, force: true }));
	const harnessId = ++harnessSequence;
	const wrapperPath = join(root, `background-test-wrapper-${harnessId}.ts`);
	const schedulerKey = `__piBackgroundWakeRetryScheduler${harnessId}`;
	if (options.wakeRetryScheduler) {
		globalThis[schedulerKey] = options.wakeRetryScheduler;
		t.after(() => { delete globalThis[schedulerKey]; });
	}
	const schedulerOption = options.wakeRetryScheduler
		? `, wakeRetryScheduler: (globalThis as any)[${JSON.stringify(schedulerKey)}]`
		: "";
	writeFileSync(wrapperPath, [
		`import { createBackgroundTasksExtension } from ${JSON.stringify(extensionIndexPath)};`,
		`export default createBackgroundTasksExtension({ runsDir: ${JSON.stringify(join(root, "runs"))}, completionDebounceMs: 0, completedTaskHoldMs: 30, wakeWatchdogMs: 40, wakeRetryBaseMs: ${JSON.stringify(options.wakeRetryBaseMs ?? 10)}, wakeRetryMaxMs: ${JSON.stringify(options.wakeRetryMaxMs ?? 20)}, killConfirmMs: 40${schedulerOption} });`,
		"",
	].join("\n"));

	const entries = options.entries ?? [];
	const messages = [];
	const lifecycle = [];
	const notifications = [];
	const widgets = new Map();
	const statuses = new Map();
	const runtime = loader.createExtensionRuntime();
	runtime.appendEntry = (customType, data) => {
		if (options.onAppend) return options.onAppend(customType, data, entries);
		entries.push({ type: "custom", customType, data });
	};
	runtime.sendMessage = (message, sendOptions) => {
		if (options.onSend) return options.onSend(message, sendOptions, messages);
		messages.push({ message, options: sendOptions });
	};
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
	let idle = true;
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: false,
		isIdle: () => idle,
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
		if (event === "agent_start") idle = false;
		if (event === "agent_settled") idle = payload.idle ?? true;
		let result;
		for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, ctx);
		return result;
	}
	return {
		root, tools, entries, messages, lifecycle, notifications, widgets, statuses, ctx, fire,
		setIdle(value) { idle = value; },
	};
}

async function execute(tool, params, ctx) {
	return tool.execute("tool-call", params, undefined, undefined, ctx);
}

async function beginPlanAndRun(h, { taskId = "job", title = "Job", command = "printf 'done\\n'", timeoutMs = 2_000 } = {}) {
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		tasks: [{ id: taskId, title, status: "pending" }],
	}, h.ctx);
	await h.fire("agent_start");
	return execute(h.tools.get("run_background_task"), { taskId, command, timeoutMs }, h.ctx);
}

async function settleParentAndWaitForWake(h, count = 1) {
	await h.fire("agent_settled", { idle: true });
	await waitFor(() => h.messages.length >= count, "background wake was not sent");
	return h.messages[count - 1];
}

async function explicitlyAcknowledge(h, sent) {
	await h.fire("agent_start");
	await h.fire("message_start", { message: { role: "custom", ...sent.message } });
	await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
	await h.fire("agent_settled", { idle: true });
}

function latestPlanMarker(entries) {
	return [...entries].reverse().find((entry) => entry.customType === TASK_PLAN_MARKER_TYPE)?.data;
}

function wakeMarkers(entries, kind) {
	return entries.filter((entry) => entry.customType === BACKGROUND_WAKE_MARKER_TYPE && (!kind || entry.data?.kind === kind));
}

function planEntry(tasks, revision = 1, sessionId = "session-test") {
	return {
		type: "custom",
		customType: TASK_PLAN_MARKER_TYPE,
		data: durableTaskPlanMarker({ version: 1, revision, reason: "", updatedAt: Date.now(), tasks }, sessionId),
	};
}

function terminal(runId, taskId, overrides = {}) {
	const now = Date.now();
	return {
		version: BACKGROUND_RUN_RECORD_VERSION,
		sessionId: "session-test",
		runId,
		taskId,
		status: "completed",
		createdAt: now - 100,
		startedAt: now - 100,
		finishedAt: now - 10,
		timeoutAt: now + 1_000,
		terminationReason: "completed",
		exitCode: 0,
		...overrides,
	};
}

async function persistTerminal(root, record) {
	const directory = await prepareSecureRunDirectory(join(root, "runs"), record.sessionId, record.runId, record.taskId);
	await writeTerminalRunManifest(directory, record);
}

function persistedFiles(root) {
	const base = join(root, "runs");
	const result = [];
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const target = join(directory, entry.name);
			if (entry.isDirectory()) walk(target);
			else result.push(`${entry.name}\n${readFileSync(target, "utf8")}`);
		}
	};
	try { walk(base); } catch { /* no storage */ }
	return result.join("\n");
}

function withWebDisabled(t) {
	const previous = process.env.PI_WEB_SESSION;
	process.env.PI_WEB_SESSION = "0";
	t.after(() => {
		if (previous === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previous;
	});
}

test("dynamic revision, busy coalescing boundary and explicit stop ack work end to end", async (t) => {
	withWebDisabled(t);
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: 0,
		tasks: [
			{ id: "benchmark", title: "Run benchmark", status: "pending" },
			{ id: "analyze", title: "Analyze", status: "pending" },
		],
	}, h.ctx);
	await h.fire("agent_start");
	const launch = await execute(h.tools.get("run_background_task"), {
		taskId: "benchmark",
		command: "sleep 0.08; printf '\\033[31mscore=42\\033[0m\\n'",
	}, h.ctx);
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: launch.details.planRevision,
		tasks: [
			{ id: "benchmark", title: "Run benchmark", status: "in_progress" },
			{ id: "report", title: "Report first", status: "pending" },
			{ id: "analyze", title: "Analyze", status: "pending" },
		],
	}, h.ctx);
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	await h.fire("agent_settled", { idle: false });
	await sleep(20);
	assert.equal(h.messages.length, 0, "nested/busy settle must not flush");
	const wake = await settleParentAndWaitForWake(h);
	assert.match(wake.message.content, /score=42/);
	assert.equal(wake.message.content.includes("\u001b"), false);
	assert.match(wake.message.content, /Task plan revision 4/);
	assert.match(wake.message.content, /Next pending task from the latest revision: report/);
	assert.equal(wake.message.details.wake.items.length, 1);
	await explicitlyAcknowledge(h, wake);
	assert.equal(wakeMarkers(h.entries, "acknowledged").length, 1);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("secret command, output, cwd, title and pid never enter durable files or custom markers", async (t) => {
	withWebDisabled(t);
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	const secretTitle = "confidential task title sentinel";
	const secretCommand = "TOKEN=credential-secret-sentinel; printf 'stdout-secret-sentinel %s\\n' \"$TOKEN\"; printf 'stderr-secret-sentinel\\n' >&2; printf 'pid-secret=%s\\n' $$";
	const launch = await beginPlanAndRun(h, { taskId: "privacy", title: secretTitle, command: secretCommand });
	assert.match(launch.details.run.id, /^bg-[a-f0-9]{32}$/);
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "privacy run did not finish");
	const wake = await settleParentAndWaitForWake(h);
	assert.match(wake.message.content, /stdout-secret-sentinel/);
	const durable = `${persistedFiles(h.root)}\n${JSON.stringify(h.entries)}`;
	for (const forbidden of [
		secretTitle,
		secretCommand,
		"stdout-secret-sentinel",
		"stderr-secret-sentinel",
		"credential-secret-sentinel",
		"pid-secret=",
		h.root,
		"stdout.log",
		"stderr.log",
	]) {
		assert.equal(durable.includes(forbidden), false, `durable state leaked ${forbidden}`);
	}
	assert.ok(latestPlanMarker(h.entries));
	await explicitlyAcknowledge(h, wake);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("pending marker append failure sends zero messages and keeps retryable memory state", async (t) => {
	withWebDisabled(t);
	let pendingAttempts = 0;
	const h = await harness(t, {
		onAppend(customType, data, entries) {
			if (customType === BACKGROUND_WAKE_MARKER_TYPE && data.kind === "pending") {
				pendingAttempts += 1;
				throw new Error("injected append failure");
			}
			entries.push({ type: "custom", customType, data });
		},
	});
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 0" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	await h.fire("agent_settled", { idle: true });
	await sleep(70);
	assert.ok(pendingAttempts >= 2, "pending marker should retry with backoff");
	assert.equal(h.messages.length, 0, "send must be gated by successful append");
	assert.equal(wakeMarkers(h.entries, "delivery").length, 0);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("terminal plan marker failure also gates send until durable retry succeeds", async (t) => {
	withWebDisabled(t);
	let terminalPlanAttempts = 0;
	const h = await harness(t, {
		onAppend(customType, data, entries) {
			if (customType === TASK_PLAN_MARKER_TYPE && data.revision >= 3) {
				terminalPlanAttempts += 1;
				throw new Error("injected plan failure");
			}
			entries.push({ type: "custom", customType, data });
		},
	});
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 0" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	await h.fire("agent_settled", { idle: true });
	await sleep(60);
	assert.ok(terminalPlanAttempts >= 2);
	assert.equal(h.messages.length, 0);
	assert.equal(wakeMarkers(h.entries, "pending").length, 0, "pending must wait for its terminal plan marker");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("send failure and missing agent_start are retried with new explicit attempts", async (t) => {
	withWebDisabled(t);
	let sends = 0;
	const h = await harness(t, {
		onSend(message, options, messages) {
			sends += 1;
			if (sends === 1) throw new Error("injected send failure");
			messages.push({ message, options });
		},
	});
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 0" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	await h.fire("agent_settled", { idle: true });
	await waitFor(() => h.messages.length === 1, "send failure was not retried");
	const firstSuccessfulAttempt = h.messages[0].message.details.wake.attempt;
	assert.ok(firstSuccessfulAttempt >= 2);
	// Do not fire agent_start/message_start: watchdog must release the queue.
	await waitFor(() => h.messages.length === 2, "missing agent_start watchdog did not retry", 1_000);
	assert.ok(h.messages[1].message.details.wake.attempt > firstSuccessfulAttempt);
	assert.equal(h.messages[1].message.details.wake.items[0].runId, h.messages[0].message.details.wake.items[0].runId);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("wake retry backoff grows base, 2x, 4x, caps, has one timer and resets only after ack", async (t) => {
	withWebDisabled(t);
	const retryScheduler = new FakeWakeRetryScheduler();
	let failuresRemaining = 4;
	let failNextBatch = false;
	const h = await harness(t, {
		wakeRetryScheduler: retryScheduler,
		wakeRetryBaseMs: 10,
		wakeRetryMaxMs: 50,
		onSend(message, options, messages) {
			if (failuresRemaining > 0) {
				failuresRemaining -= 1;
				throw new Error("injected retry failure");
			}
			if (failNextBatch) {
				failNextBatch = false;
				throw new Error("injected post-ack failure");
			}
			messages.push({ message, options });
		},
	});
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { taskId: "first", title: "First", command: "exit 0" });
	await waitFor(() => h.lifecycle.filter((item) => item.event === "background-task:completed").length === 1, "first completion missing");
	await h.fire("agent_settled", { idle: true });
	await waitFor(() => retryScheduler.delays.length === 1, "first retry was not scheduled");
	assert.deepEqual(retryScheduler.delays, [10]);
	assert.equal(retryScheduler.pendingCount, 1);
	await h.fire("agent_settled", { idle: true });
	assert.equal(retryScheduler.pendingCount, 1, "the same pending wake must not create a concurrent timer");

	for (const expectedDelay of [20, 40, 50]) {
		retryScheduler.runNext();
		await waitFor(() => retryScheduler.delays.at(-1) === expectedDelay, `retry ${expectedDelay}ms was not scheduled`);
		assert.equal(retryScheduler.pendingCount, 1);
	}
	assert.deepEqual(retryScheduler.delays, [10, 20, 40, 50]);
	retryScheduler.runNext();
	await waitFor(() => h.messages.length === 1, "successful retry was not sent");
	assert.equal(retryScheduler.pendingCount, 0);
	await explicitlyAcknowledge(h, h.messages[0]);
	assert.equal(wakeMarkers(h.entries, "acknowledged").length, 1);

	const revision = latestPlanMarker(h.entries).revision;
	await execute(h.tools.get("update_task_plan"), {
		baseRevision: revision,
		tasks: [
			{ id: "first", title: "First", status: "completed" },
			{ id: "second", title: "Second", status: "pending" },
		],
	}, h.ctx);
	failNextBatch = true;
	await h.fire("agent_start");
	await execute(h.tools.get("run_background_task"), { taskId: "second", command: "exit 0" }, h.ctx);
	await waitFor(() => h.lifecycle.filter((item) => item.event === "background-task:completed").length === 2, "second completion missing");
	await h.fire("agent_settled", { idle: true });
	await waitFor(() => retryScheduler.delays.length === 5, "post-ack retry was not scheduled");
	assert.equal(retryScheduler.delays[4], 10, "a matching explicit ack must reset the next outbox to base delay");
	assert.equal(retryScheduler.pendingCount, 1);
	await h.fire("session_shutdown", { reason: "quit" });
	assert.equal(retryScheduler.pendingCount, 0, "shutdown must clear the injected retry scheduler");
});

test("toolUse followed by error and unrelated success cannot acknowledge", async (t) => {
	withWebDisabled(t);
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 2" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:failed"), "failure missing");
	const wake = await settleParentAndWaitForWake(h);
	await h.fire("agent_start");
	await h.fire("message_start", { message: { role: "custom", ...wake.message } });
	await h.fire("message_end", { message: { role: "assistant", stopReason: "toolUse", content: [] } });
	await h.fire("message_end", { message: { role: "assistant", stopReason: "error", content: [] } });
	// An unrelated later run and success cannot repair this failed attempt.
	await h.fire("agent_start");
	await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
	await h.fire("agent_settled", { idle: true });
	assert.equal(wakeMarkers(h.entries, "acknowledged").length, 0);
	await waitFor(() => h.messages.length >= 2, "failed attempt was not released for retry");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("successful response is not acknowledged at a nested busy settle", async (t) => {
	withWebDisabled(t);
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 0" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	const wake = await settleParentAndWaitForWake(h);
	await h.fire("agent_start");
	await h.fire("message_start", { message: { role: "custom", ...wake.message } });
	await h.fire("message_end", { message: { role: "assistant", stopReason: "stop", content: [] } });
	await h.fire("agent_settled", { idle: false });
	assert.equal(wakeMarkers(h.entries, "acknowledged").length, 0);
	await h.fire("agent_settled", { idle: true });
	assert.equal(wakeMarkers(h.entries, "acknowledged").length, 1);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("shutdown cancels watchdog and retry without waking the old session", async (t) => {
	withWebDisabled(t);
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 0" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	await h.fire("agent_settled", { idle: true });
	await waitFor(() => h.messages.length === 1, "initial wake missing");
	await h.fire("session_shutdown", { reason: "reload" });
	const sentAtShutdown = h.messages.length;
	const markersAtShutdown = wakeMarkers(h.entries, "delivery").length;
	await sleep(100);
	assert.equal(h.messages.length, sentAtShutdown);
	assert.equal(wakeMarkers(h.entries, "delivery").length, markersAtShutdown);
});

test("forced branch navigation cancels an old delivery watchdog", async (t) => {
	withWebDisabled(t);
	const h = await harness(t);
	await h.fire("session_start", { reason: "startup" });
	await beginPlanAndRun(h, { command: "exit 0" });
	await waitFor(() => h.lifecycle.some((item) => item.event === "background-task:completed"), "completion missing");
	await h.fire("agent_settled", { idle: true });
	await waitFor(() => h.messages.length === 1, "initial wake missing");
	h.entries.splice(0, h.entries.length); // model a target branch without the old outbox
	await h.fire("session_tree", { newLeafId: "forced" });
	const count = h.messages.length;
	await sleep(100);
	assert.equal(h.messages.length, count, "old branch watchdog must not send again");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("valid terminal manifest recovers an in-progress plan without durable output", async (t) => {
	withWebDisabled(t);
	const root = mkdtempSync(join(tmpdir(), "pi-background-recover-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const record = terminal("bg-recovered", "benchmark");
	await persistTerminal(root, record);
	const entries = [planEntry([
		{ id: "benchmark", title: "benchmark", status: "in_progress", updatedAt: record.startedAt, runId: record.runId },
		{ id: "analyze", title: "analyze", status: "pending", updatedAt: record.startedAt },
	], 7)];
	const h = await harness(t, { root, entries });
	await h.fire("session_start", { reason: "reload" });
	await waitFor(() => h.messages.length === 1, "terminal recovery did not wake");
	assert.equal(h.messages[0].message.details.runs[0].terminationReason, "completed");
	assert.match(h.messages[0].message.content, /Task plan revision 8/);
	assert.equal(h.messages[0].message.content.includes("stdout tail"), false);
	await explicitlyAcknowledge(h, h.messages[0]);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("terminal plan with valid manifest recovers the plan-to-outbox crash window", async (t) => {
	withWebDisabled(t);
	const root = mkdtempSync(join(tmpdir(), "pi-background-terminal-window-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const record = terminal("bg-terminal-window", "finished");
	await persistTerminal(root, record);
	const entries = [planEntry([
		{ id: "finished", title: "finished", status: "completed", updatedAt: record.finishedAt, runId: record.runId },
	], 5)];
	const h = await harness(t, { root, entries });
	await h.fire("session_start", { reason: "reload" });
	await waitFor(() => h.messages.length === 1, "terminal plan crash window was not recovered");
	assert.equal(h.messages[0].message.details.runs[0].terminationReason, "completed");
	assert.equal(wakeMarkers(h.entries, "pending").length, 1);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("missing in-progress manifest fails closed as monitor_restarted", async (t) => {
	withWebDisabled(t);
	const now = Date.now();
	const entries = [planEntry([
		{ id: "remote", title: "remote", status: "in_progress", updatedAt: now, runId: "bg-lost-owner" },
	], 3)];
	const h = await harness(t, { entries });
	await h.fire("session_start", { reason: "reload" });
	await waitFor(() => h.messages.length === 1, "lost monitor did not wake");
	assert.equal(h.messages[0].message.details.runs[0].terminationReason, "monitor_restarted");
	assert.match(h.messages[0].message.content, /ownership cannot be safely reattached/);
	await explicitlyAcknowledge(h, h.messages[0]);
	await h.fire("session_shutdown", { reason: "reload" });
	const resumed = await harness(t, { root: h.root, entries });
	await resumed.fire("session_start", { reason: "reload" });
	await sleep(50);
	assert.equal(resumed.messages.length, 0, "acknowledged monitor_restarted must not become a second missing-manifest wake");
	await resumed.fire("session_shutdown", { reason: "quit" });
});

test("terminal plan with missing manifest becomes a bounded recovery_blocked wake", async (t) => {
	withWebDisabled(t);
	const now = Date.now();
	const entries = [planEntry([
		{ id: "done", title: "done", status: "completed", updatedAt: now, runId: "bg-missing-terminal" },
	], 4)];
	const h = await harness(t, { entries });
	await h.fire("session_start", { reason: "reload" });
	await waitFor(() => h.messages.length === 1, "invalid terminal recovery did not wake");
	assert.equal(h.messages[0].message.details.runs[0].terminationReason, "recovery_blocked");
	assert.equal(latestPlanMarker(h.entries).tasks[0].status, "blocked");
	assert.equal(JSON.stringify(h.entries).includes(h.root), false);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("corrupted terminal manifest is surfaced as recovery_blocked rather than skipped", async (t) => {
	withWebDisabled(t);
	const root = mkdtempSync(join(tmpdir(), "pi-background-corrupt-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const runId = "bg-corrupt-terminal";
	const taskId = "corrupt";
	const directory = await prepareSecureRunDirectory(join(root, "runs"), "session-test", runId, taskId);
	writeFileSync(join(directory, "result.json"), "{not-json}\n", { mode: 0o600 });
	const entries = [planEntry([
		{ id: taskId, title: taskId, status: "failed", updatedAt: Date.now(), runId },
	], 2)];
	const h = await harness(t, { root, entries });
	await h.fire("session_start", { reason: "reload" });
	await waitFor(() => h.messages.length === 1, "corrupt manifest was silently skipped");
	assert.equal(h.messages[0].message.details.runs[0].terminationReason, "recovery_blocked");
	assert.match(h.messages[0].message.content, /invalid_json/);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("restored pending completions coalesce and carry stable run/sequence/attempt identities", async (t) => {
	withWebDisabled(t);
	const root = mkdtempSync(join(tmpdir(), "pi-background-coalesce-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const one = terminal("bg-one", "one");
	const two = terminal("bg-two", "two");
	await persistTerminal(root, one);
	await persistTerminal(root, two);
	const entries = [
		planEntry([
			{ id: "one", title: "one", status: "completed", updatedAt: one.finishedAt, runId: one.runId },
			{ id: "two", title: "two", status: "completed", updatedAt: two.finishedAt, runId: two.runId },
		], 5),
		{ type: "custom", customType: BACKGROUND_WAKE_MARKER_TYPE, data: pendingWakeMarker(one, 10) },
		{ type: "custom", customType: BACKGROUND_WAKE_MARKER_TYPE, data: pendingWakeMarker(two, 11) },
	];
	const h = await harness(t, { root, entries });
	await h.fire("session_start", { reason: "reload" });
	await waitFor(() => h.messages.length === 1, "coalesced wake missing");
	assert.deepEqual(h.messages[0].message.details.wake.items.map((item) => item.runId), ["bg-one", "bg-two"]);
	assert.deepEqual(h.messages[0].message.details.wake.items.map((item) => item.sequence), [10, 11]);
	assert.ok(h.messages[0].message.details.wake.attempt >= 1);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("unsafe framework session id disables recovery and launch", async (t) => {
	withWebDisabled(t);
	const h = await harness(t, { sessionId: "../unsafe-session" });
	await h.fire("session_start", { reason: "startup" });
	assert.ok(h.notifications.some((item) => /session identity/.test(item.message)));
	await assert.rejects(
		execute(h.tools.get("run_background_task"), { taskId: "job", command: "exit 0" }, h.ctx),
		/session binding unavailable/,
	);
	await h.fire("session_shutdown", { reason: "quit" });
});
