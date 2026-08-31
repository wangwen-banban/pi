import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test, { after } from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBusModule = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const helperPath = fileURLToPath(new URL("./activity-widget-stack.ts", import.meta.url));
const testRoot = mkdtempSync(join(tmpdir(), "pi-activity-widget-stack-"));
after(() => rmSync(testRoot, { recursive: true, force: true }));

let wrapperSequence = 0;
async function loadHelper(sourcePath) {
	const exportKey = `__piActivityWidgetHelperTest${++wrapperSequence}`;
	const wrapperPath = join(testRoot, `helper-wrapper-${wrapperSequence}.ts`);
	writeFileSync(wrapperPath, [
		`import * as helper from ${JSON.stringify(sourcePath)};`,
		`(globalThis as any)[${JSON.stringify(exportKey)}] = helper;`,
		"export default function () {}",
		"",
	].join("\n"));
	const loaded = await loader.loadExtensions(
		[wrapperPath],
		testRoot,
		eventBusModule.createEventBus(),
		loader.createExtensionRuntime(),
	);
	assert.deepEqual(loaded.errors, []);
	const helper = globalThis[exportKey];
	delete globalThis[exportKey];
	assert.ok(helper);
	return helper;
}

const helperA = await loadHelper(helperPath);
const helperCopyPath = join(testRoot, "activity-widget-stack-copy.ts");
copyFileSync(helperPath, helperCopyPath);
const helperB = await loadHelper(helperCopyPath);

class FakeUi {
	widgets = new Map();
	placements = new Map();
	calls = [];
	renderRequests = 0;
	statuses = new Map();
	notifications = [];

	tui = {
		requestRender: () => { this.renderRequests += 1; },
	};

	theme = {
		fg: (tone, text) => tone === "muted" ? `<muted>${text}</muted>` : text,
	};

	setWidget(key, content, options) {
		const existing = this.widgets.get(key);
		existing?.dispose?.();
		this.widgets.delete(key);
		this.placements.delete(key);
		this.calls.push({ key, content, options });
		if (content === undefined) return;
		const component = Array.isArray(content)
			? { render: () => [...content], invalidate() {} }
			: content(this.tui, this.theme);
		this.widgets.set(key, component);
		this.placements.set(key, options?.placement ?? "aboveEditor");
	}

	setStatus(key, value) {
		if (value === undefined) this.statuses.delete(key);
		else this.statuses.set(key, value);
	}

	notify(message, kind) {
		this.notifications.push({ message, kind });
	}

	seedWidget(key, component = { render: () => [key], invalidate() {} }) {
		this.widgets.set(key, component);
	}

	render(key = helperA.ACTIVITY_WIDGET_KEY, width = 160) {
		return (this.widgets.get(key)?.render(width) ?? []).map((line) => line.trimEnd());
	}
}

function trimmed(ui) {
	return ui.render().map((line) => line.trim());
}

test("100 alternating refreshes keep Tasks above Sub Agents without re-registering the stack", () => {
	const ui = new FakeUi();
	const tasks = helperA.createActivityWidgetOwner("tasks");
	const agents = helperA.createActivityWidgetOwner("subagents");
	// Reverse the desired visual order on first registration to prove load/update order is irrelevant.
	helperA.setActivityWidgetSection(ui, agents, ["Sub Agents", "└─ agent-0 ● running"]);
	helperA.setActivityWidgetSection(ui, tasks, ["Tasks · revision 0", "○ task-0"]);

	for (let index = 1; index <= 100; index += 1) {
		if (index % 2 === 0) {
			helperA.setActivityWidgetSection(ui, tasks, [`Tasks · revision ${index}`, `○ task-${index}`]);
		} else {
			helperA.setActivityWidgetSection(ui, agents, ["Sub Agents", `└─ agent-${index} ● running`]);
		}
		const lines = trimmed(ui);
		assert.ok(lines.indexOf(`Tasks · revision ${index - (index % 2)}`) < lines.indexOf("Sub Agents"));
	}

	const registrations = ui.calls.filter((call) => call.key === helperA.ACTIVITY_WIDGET_KEY && typeof call.content === "function");
	assert.equal(registrations.length, 1);
	assert.equal(ui.placements.get(helperA.ACTIVITY_WIDGET_KEY), "aboveEditor");
});

test("presentation lease freezes 100 alternating updates and flushes the latest ordered snapshot once", () => {
	const ui = new FakeUi();
	const tasks = helperA.createActivityWidgetOwner("tasks");
	const agents = helperA.createActivityWidgetOwner("subagents");
	helperA.setActivityWidgetSection(ui, agents, ["Sub Agents", "└─ agent-0"]);
	helperA.setActivityWidgetSection(ui, tasks, ["Tasks · revision 0", "○ task-0"]);

	const frozen = trimmed(ui);
	const callsBeforeLease = ui.calls.length;
	const rendersBeforeLease = ui.renderRequests;
	const lease = helperA.acquireActivityWidgetPresentationLease(ui);
	for (let index = 1; index <= 100; index += 1) {
		if (index % 2 === 0) {
			helperA.setActivityWidgetSection(ui, tasks, [`Tasks · revision ${index}`, `○ task-${index}`]);
		} else {
			helperA.setActivityWidgetSection(ui, agents, ["Sub Agents", `└─ agent-${index}`]);
		}
		ui.tui.requestRender(); // Simulate unrelated full-TUI/spinner redraw pressure.
		ui.widgets.get(helperA.ACTIVITY_WIDGET_KEY).invalidate();
		assert.deepEqual(trimmed(ui), frozen, "invalidations must keep the leased snapshot static");
	}

	assert.equal(ui.calls.length, callsBeforeLease, "leased updates must not call setWidget");
	assert.equal(
		ui.renderRequests,
		rendersBeforeLease + 100,
		"only the 100 simulated external redraws may request presentation",
	);
	lease.release();
	assert.equal(ui.calls.length, callsBeforeLease, "mounted stack refreshes without re-registering");
	assert.equal(ui.renderRequests, rendersBeforeLease + 101, "outer release renders at most once");
	assert.deepEqual(trimmed(ui), ["Tasks · revision 100", "○ task-100", "Sub Agents", "└─ agent-99"]);
	lease.release();
	assert.equal(ui.renderRequests, rendersBeforeLease + 101, "lease release is idempotent");
});

test("nested leases preserve clear and owner replacement semantics until the outer release", () => {
	const ui = new FakeUi();
	const oldTasks = helperA.createActivityWidgetOwner("tasks");
	const oldAgents = helperA.createActivityWidgetOwner("subagents");
	helperA.setActivityWidgetSection(ui, oldTasks, ["Tasks old"]);
	helperA.setActivityWidgetSection(ui, oldAgents, ["Sub Agents old"]);
	const frozen = trimmed(ui);

	const outer = helperA.acquireActivityWidgetPresentationLease(ui);
	const inner = helperB.acquireActivityWidgetPresentationLease(ui);
	const newTasks = helperB.createActivityWidgetOwner("tasks");
	const newAgents = helperB.createActivityWidgetOwner("subagents");
	helperB.setActivityWidgetSection(ui, newTasks, ["Tasks new"]);
	helperB.setActivityWidgetSection(ui, newAgents, ["Sub Agents new"]);
	helperB.setActivityWidgetSection(ui, newAgents); // Current owner clears only its own section.
	const callsWhileFrozen = ui.calls.length;
	const rendersWhileFrozen = ui.renderRequests;

	// Owners retired by replacement can neither clear nor republish over the new owner.
	helperA.setActivityWidgetSection(ui, oldTasks);
	helperA.setActivityWidgetSection(ui, oldTasks, ["Tasks stale"]);
	helperA.releaseActivityWidgetSection(ui, oldAgents);
	assert.equal(ui.calls.length, callsWhileFrozen);
	assert.equal(ui.renderRequests, rendersWhileFrozen);
	assert.deepEqual(trimmed(ui), frozen);

	outer.release();
	outer.release();
	assert.equal(ui.renderRequests, rendersWhileFrozen, "inner lease still owns the freeze");
	inner.release();
	assert.equal(ui.renderRequests, rendersWhileFrozen + 1);
	assert.deepEqual(trimmed(ui), ["Tasks new"]);

	const shutdownLease = helperA.acquireActivityWidgetPresentationLease(ui);
	helperB.releaseActivityWidgetSection(ui, newTasks);
	assert.deepEqual(trimmed(ui), ["Tasks new"], "shutdown clear stays static during a lease");
	shutdownLease.release();
	assert.equal(ui.widgets.has(helperA.ACTIVITY_WIDGET_KEY), false, "final empty snapshot removes the widget");
});

test("presentation leases are isolated between UI objects", () => {
	const first = new FakeUi();
	const second = new FakeUi();
	const firstOwner = helperA.createActivityWidgetOwner("tasks");
	const secondOwner = helperA.createActivityWidgetOwner("tasks");
	helperA.setActivityWidgetSection(first, firstOwner, ["Tasks first · old"]);
	helperA.setActivityWidgetSection(second, secondOwner, ["Tasks second · old"]);
	const firstLease = helperA.acquireActivityWidgetPresentationLease(first);
	const secondLease = helperA.acquireActivityWidgetPresentationLease(second);
	helperA.setActivityWidgetSection(first, firstOwner, ["Tasks first · new"]);
	helperA.setActivityWidgetSection(second, secondOwner, ["Tasks second · new"]);

	firstLease.release();
	assert.deepEqual(trimmed(first), ["Tasks first · new"]);
	assert.deepEqual(trimmed(second), ["Tasks second · old"]);
	secondLease.release();
	assert.deepEqual(trimmed(second), ["Tasks second · new"]);
});

test("either section can render alone", () => {
	const tasksUi = new FakeUi();
	const agentsUi = new FakeUi();
	helperA.setActivityWidgetSection(tasksUi, helperA.createActivityWidgetOwner("tasks"), ["Tasks", "○ one"]);
	helperA.setActivityWidgetSection(agentsUi, helperA.createActivityWidgetOwner("subagents"), ["Sub Agents", "└─ one"]);
	assert.deepEqual(trimmed(tasksUi), ["Tasks", "○ one"]);
	assert.deepEqual(trimmed(agentsUi), ["Sub Agents", "└─ one"]);
});

test("clearing one section preserves the other and clearing both removes the shared widget", () => {
	const ui = new FakeUi();
	const tasks = helperA.createActivityWidgetOwner("tasks");
	const agents = helperA.createActivityWidgetOwner("subagents");
	helperA.setActivityWidgetSection(ui, tasks, ["Tasks"]);
	helperA.setActivityWidgetSection(ui, agents, ["Sub Agents"]);
	helperA.setActivityWidgetSection(ui, tasks);
	assert.deepEqual(trimmed(ui), ["Sub Agents"]);
	assert.ok(ui.widgets.has(helperA.ACTIVITY_WIDGET_KEY));
	helperA.setActivityWidgetSection(ui, agents);
	assert.equal(ui.widgets.has(helperA.ACTIVITY_WIDGET_KEY), false);
});

test("owner replacement is shared across module copies and makes stale shutdown a no-op", () => {
	const ui = new FakeUi();
	const oldOwner = helperA.createActivityWidgetOwner("subagents");
	const newOwner = helperB.createActivityWidgetOwner("subagents");
	helperA.setActivityWidgetSection(ui, oldOwner, ["Sub Agents", "└─ old"]);
	helperB.setActivityWidgetSection(ui, newOwner, ["Sub Agents", "└─ new"]);
	const callsBeforeShutdown = ui.calls.length;
	helperA.releaseActivityWidgetSection(ui, oldOwner);
	assert.equal(ui.calls.length, callsBeforeShutdown);
	assert.deepEqual(trimmed(ui), ["Sub Agents", "└─ new"]);
	helperB.releaseActivityWidgetSection(ui, newOwner);
	assert.equal(ui.widgets.has(helperA.ACTIVITY_WIDGET_KEY), false);
});

test("separate UI objects keep independent owners, content, and lifecycle", () => {
	const first = new FakeUi();
	const second = new FakeUi();
	const firstOwner = helperA.createActivityWidgetOwner("tasks");
	const secondOwner = helperA.createActivityWidgetOwner("tasks");
	helperA.setActivityWidgetSection(first, firstOwner, ["Tasks first"]);
	helperA.setActivityWidgetSection(second, secondOwner, ["Tasks second"]);
	helperA.releaseActivityWidgetSection(first, firstOwner);
	assert.equal(first.widgets.has(helperA.ACTIVITY_WIDGET_KEY), false);
	assert.deepEqual(trimmed(second), ["Tasks second"]);
});

test("each section independently keeps ten lines, a muted truncation notice, and one-cell indentation", () => {
	const ui = new FakeUi();
	const taskLines = Array.from({ length: 12 }, (_, index) => `task-${index}`);
	const agentLines = Array.from({ length: 13 }, (_, index) => `agent-${index}`);
	helperA.setActivityWidgetSection(ui, helperA.createActivityWidgetOwner("tasks"), taskLines);
	helperA.setActivityWidgetSection(ui, helperA.createActivityWidgetOwner("subagents"), agentLines);
	const lines = ui.render();
	const content = lines.map((line) => line.trim());
	assert.deepEqual(content, [
		...taskLines.slice(0, 10),
		"<muted>... (widget truncated)</muted>",
		...agentLines.slice(0, 10),
		"<muted>... (widget truncated)</muted>",
	]);
	assert.ok(lines.every((line) => line.startsWith(" ")), "every rendered row keeps Text's one-cell left padding");
	assert.equal(content.includes("task-10"), false);
	assert.equal(content.includes("agent-10"), false);
});

test("first touch removes both legacy widget keys before installing the shared stack", () => {
	const ui = new FakeUi();
	for (const key of helperA.LEGACY_ACTIVITY_WIDGET_KEYS) ui.seedWidget(key);
	helperA.setActivityWidgetSection(ui, helperA.createActivityWidgetOwner("tasks"), ["Tasks"]);
	for (const key of helperA.LEGACY_ACTIVITY_WIDGET_KEYS) {
		assert.equal(ui.widgets.has(key), false);
		assert.ok(ui.calls.some((call) => call.key === key && call.content === undefined));
	}
	assert.deepEqual([...ui.widgets.keys()], [helperA.ACTIVITY_WIDGET_KEY]);
});

test("real background and smart extension harnesses publish only the shared display widget", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-activity-extension-harness-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const previousWebSession = process.env.PI_WEB_SESSION;
	process.env.PI_CODING_AGENT_DIR = root;
	process.env.PI_WEB_SESSION = "0";
	try {
		const backgroundIndex = fileURLToPath(new URL("../background-tasks/index.ts", import.meta.url));
		const smartIndex = fileURLToPath(new URL("../smart-subagents/index.ts", import.meta.url));
		const backgroundWrapper = join(root, "background-wrapper.ts");
		writeFileSync(backgroundWrapper, [
			`import { createBackgroundTasksExtension } from ${JSON.stringify(backgroundIndex)};`,
			`export default createBackgroundTasksExtension({ runsDir: ${JSON.stringify(join(root, "background-runs"))}, completionDebounceMs: 0 });`,
			"",
		].join("\n"));

		const entries = [];
		const runtime = loader.createExtensionRuntime();
		runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
		runtime.sendMessage = () => {};
		const loaded = await loader.loadExtensions(
			[backgroundWrapper, smartIndex],
			root,
			eventBusModule.createEventBus(),
			runtime,
		);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 2);

		const ui = new FakeUi();
		const ctx = {
			cwd: root,
			mode: "tui",
			hasUI: true,
			isIdle: () => true,
			model: undefined,
			scopedModels: [],
			modelRegistry: {},
			sessionManager: {
				getSessionId: () => "activity-harness-session",
				getBranch: () => entries,
				getEntries: () => entries,
			},
			ui,
		};
		const fire = async (event) => {
			for (const extension of loaded.extensions) {
				for (const handler of extension.handlers.get(event) ?? []) {
					await handler({ type: event, reason: event === "session_shutdown" ? "quit" : "startup" }, ctx);
				}
			}
		};
		await fire("session_start");

		const tools = new Map();
		for (const extension of loaded.extensions) {
			for (const [name, entry] of extension.tools) tools.set(name, entry.definition);
		}
		await tools.get("update_task_plan").execute("plan", {
			baseRevision: 0,
			tasks: [{ id: "verify", title: "Verify stable stack", status: "pending" }],
		}, undefined, undefined, ctx);
		await assert.rejects(
			tools.get("delegate_subagent").execute(
				"delegate",
				{ task: "Exercise the real activity widget path", taskName: "widget_harness" },
				AbortSignal.abort(),
				undefined,
				ctx,
			),
			/Dispatch aborted before routing/,
		);

		const rendered = trimmed(ui);
		assert.ok(rendered.indexOf("Tasks · revision 1") < rendered.indexOf("Sub Agents"));
		const legacyDisplayCalls = ui.calls.filter((call) => (
			helperA.LEGACY_ACTIVITY_WIDGET_KEYS.includes(call.key) && call.content !== undefined
		));
		assert.deepEqual(legacyDisplayCalls, []);
		assert.ok(ui.calls.some((call) => call.key === helperA.ACTIVITY_WIDGET_KEY && typeof call.content === "function"));

		await fire("session_shutdown");
		assert.equal(ui.widgets.has(helperA.ACTIVITY_WIDGET_KEY), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		if (previousWebSession === undefined) delete process.env.PI_WEB_SESSION;
		else process.env.PI_WEB_SESSION = previousWebSession;
		rmSync(root, { recursive: true, force: true });
	}
});

test("both extension sources route display content through the shared helper", () => {
	for (const relative of ["../background-tasks/index.ts", "../smart-subagents/index.ts"]) {
		const source = readFileSync(new URL(relative, import.meta.url), "utf8");
		assert.match(source, /setActivityWidgetSection/);
		assert.match(source, /releaseActivityWidgetSection/);
		assert.doesNotMatch(source, /\.setWidget\(/);
	}
});
