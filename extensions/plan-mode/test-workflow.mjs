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
const activityHelperPath = fileURLToPath(new URL("../shared/activity-widget-stack.ts", import.meta.url));
const agentsPath = fileURLToPath(new URL("../../AGENTS.md", import.meta.url));
const tuiModule = await import(
	pathToFileURL(join(piRoot, "node_modules/@earendil-works/pi-tui/dist/index.js")).href
);
const { visibleWidth } = tuiModule;
let harnessSequence = 0;

async function harness(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-plan-mode-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const wrapperPath = join(root, "plan-mode-test-wrapper.ts");
	const activityExportKey = `__piPlanModeActivityTest${++harnessSequence}`;
	writeFileSync(wrapperPath, [
		`import * as activity from ${JSON.stringify(activityHelperPath)};`,
		`(globalThis as any)[${JSON.stringify(activityExportKey)}] = activity;`,
		`export { default } from ${JSON.stringify(extensionIndexPath)};`,
		"",
	].join("\n"));

	const entries = [];
	const notifications = [];
	const statuses = new Map();
	const uiCalls = { custom: 0, confirm: 0, input: 0 };
	const workingVisibleCalls = [];
	const customResults = [];
	const confirmResults = [];
	const inputResults = [];
	const widgetCalls = [];
	const widgets = new Map();
	let activeCustom = 0;
	let renderRequests = 0;
	let workingVisibleHook;
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
	const activity = globalThis[activityExportKey];
	delete globalThis[activityExportKey];
	assert.ok(activity);
	const extension = loaded.extensions[0];
	const tools = new Map([...extension.tools].map(([name, entry]) => [name, entry.definition]));
	const tui = {
		requestRender() { renderRequests += 1; },
	};
	const theme = {
		fg(_tone, text) { return text; },
	};
	const ui = {
		async custom(factory) {
			uiCalls.custom += 1;
			activeCustom += 1;
			let component;
			try {
				const next = customResults.length > 0 ? customResults.shift() : null;
				if (typeof next !== "function") return next;
				return await next({
					tui,
					theme,
					async createComponent(done = () => {}) {
						component = await factory(tui, theme, {}, done);
						if ("focused" in component) component.focused = true;
						return component;
					},
				});
			} finally {
				if (component && "focused" in component) component.focused = false;
				component?.dispose?.();
				activeCustom -= 1;
			}
		},
		async confirm() {
			uiCalls.confirm += 1;
			return confirmResults.length > 0 ? confirmResults.shift() : false;
		},
		async input() {
			uiCalls.input += 1;
			return inputResults.length > 0 ? inputResults.shift() : undefined;
		},
		notify(message, kind) { notifications.push({ message, kind }); },
		setStatus(key, value) { statuses.set(key, value); },
		setWorkingVisible(visible) {
			workingVisibleCalls.push(visible);
			workingVisibleHook?.(visible);
			tui.requestRender();
		},
		setWidget(key, content, options) {
			const existing = widgets.get(key);
			existing?.dispose?.();
			widgets.delete(key);
			widgetCalls.push({ key, content, options });
			if (content === undefined) return;
			const component = Array.isArray(content)
				? { render: () => [...content], invalidate() {} }
				: content(tui, theme);
			widgets.set(key, component);
		},
		theme,
	};
	const ctx = {
		cwd: root,
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "plan-mode-test-session",
			getBranch: () => entries,
		},
		ui,
	};

	async function fire(event, payload = {}) {
		let result;
		for (const handler of extension.handlers.get(event) ?? []) {
			result = await handler({ type: event, ...payload }, ctx);
		}
		return result;
	}

	return {
		activity,
		ctx,
		entries,
		fire,
		get activeCustom() { return activeCustom; },
		get renderRequests() { return renderRequests; },
		notifications,
		queueConfirm: (...values) => confirmResults.push(...values),
		queueCustom: (...values) => customResults.push(...values),
		queueInput: (...values) => inputResults.push(...values),
		renderWidget(key = activity.ACTIVITY_WIDGET_KEY, width = 160) {
			return (widgets.get(key)?.render(width) ?? []).map((line) => line.trim());
		},
		setWorkingVisibleHook(hook) { workingVisibleHook = hook; },
		statuses,
		tools,
		uiCalls,
		widgetCalls,
		widgets,
		workingVisibleCalls,
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

function assertResponsiveWidthCache(component) {
	const at64 = component.render(64);
	const cached64 = component.render(64);
	assert.equal(cached64, at64, "repeated width 64 render must hit the cache");
	assert.ok(at64.every((line) => visibleWidth(line) <= 64), "width 64 output must stay bounded");

	const at63 = component.render(63);
	assert.notEqual(at63, at64, "64→63 must recompute instead of reusing wider lines");
	const cached63 = component.render(63);
	assert.equal(cached63, at63, "repeated width 63 render must hit the cache");
	assert.ok(at63.every((line) => visibleWidth(line) <= 63), "width 63 output must stay bounded");

	const backAt64 = component.render(64);
	assert.notEqual(backAt64, at64, "63→64 must recompute again");
	assert.deepEqual(backAt64, at64, "a width has stable content and height when revisited");
	component.handleInput("\x1b[B");
	const refreshed64 = component.render(64);
	assert.notEqual(refreshed64, backAt64, "state refresh clears both cached width and lines");
	component.invalidate();
	assert.notEqual(component.render(64), refreshed64, "invalidate clears both cached width and lines");
	return at64;
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
	assert.deepEqual(h.workingVisibleCalls, [], "inactive and RPC paths never touch TUI working state");
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
	assert.deepEqual(h.workingVisibleCalls, [false, true]);
	assert.equal(h.activeCustom, 0, "approval focus is released");
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
	assert.deepEqual(h.workingVisibleCalls, [false, true, false, true]);
	assert.equal(h.activeCustom, 0, "rejected dialogs leave no focus owner");
	assert.deepEqual(h.entries.map((entry) => entry.data.state), ["active"]);
});

test("ask_user and exit_plan_mode caches are width-sensitive and render bounded 64↔63 layouts", async (t) => {
	const h = await harness(t);
	const ask = h.tools.get("ask_user");
	const enter = h.tools.get("enter_plan_mode");
	const exit = h.tools.get("exit_plan_mode");

	h.queueCustom(async ({ createComponent }) => {
		const component = await createComponent();
		assertResponsiveWidthCache(component);
		return null;
	});
	let result = await execute(ask, {
		question: "请选择一个会在窄终端中换行、但每一行都必须严格保持在可见宽度内的实现方向",
		options: [
			{ label: "保持兼容", description: "继续支持现有行为，同时加入确定性的布局缓存失效规则" },
			{ label: "简化实现", description: "减少状态，但接受较少的扩展能力" },
		],
	}, h.ctx);
	assert.match(resultText(result), /取消/);

	await execute(enter, { reason: "inspect responsive approval" }, h.ctx);
	const rawOnlySuffix = "RAW_PLAN_SUFFIX_MUST_NOT_RENDER";
	const overlongPlan = `${"approved bounded plan text ".repeat(600)}${rawOnlySuffix}`;
	h.queueCustom(async ({ createComponent }) => {
		const component = await createComponent();
		const lines = assertResponsiveWidthCache(component);
		assert.doesNotMatch(lines.join("\n"), new RegExp(rawOnlySuffix));
		return null;
	});
	result = await execute(exit, { plan: overlongPlan }, h.ctx);
	assert.match(resultText(result), /cancelled/i);
	assert.deepEqual(h.workingVisibleCalls, [false, true, false, true]);
	assert.equal(h.activeCustom, 0, "both responsive dialogs release focus");
});

test("all TUI approval outcomes freeze external presentation churn and restore working visibility", async (t) => {
	const scenarios = [
		{ name: "approve", value: "approve", expected: /APPROVED/ },
		{ name: "reject", value: "reject", expected: /REJECTED/ },
		{ name: "feedback", value: { feedback: "keep API stable" }, expected: /provided feedback/ },
		{ name: "cancel", value: null, expected: /cancelled/i },
		{ name: "custom throw", error: new Error("custom dialog exploded") },
	];

	for (const scenario of scenarios) {
		const h = await harness(t);
		const tasks = h.activity.createActivityWidgetOwner("tasks");
		const agents = h.activity.createActivityWidgetOwner("subagents");
		h.activity.setActivityWidgetSection(h.ctx.ui, tasks, ["Tasks · revision 0"]);
		h.activity.setActivityWidgetSection(h.ctx.ui, agents, ["Sub Agents", "└─ agent-0"]);
		await execute(h.tools.get("enter_plan_mode"), { reason: scenario.name }, h.ctx);

		h.queueCustom(async ({ createComponent, tui }) => {
			const component = await createComponent();
			const widgetCallsAtStart = h.widgetCalls.length;
			const rendersAtStart = h.renderRequests;
			for (let index = 1; index <= 100; index += 1) {
				if (index % 2 === 0) {
					h.activity.setActivityWidgetSection(h.ctx.ui, tasks, [`Tasks · revision ${index}`]);
				} else {
					h.activity.setActivityWidgetSection(h.ctx.ui, agents, ["Sub Agents", `└─ agent-${index}`]);
				}
				component.render(index % 2 === 0 ? 64 : 63);
				tui.requestRender();
			}
			assert.equal(h.widgetCalls.length, widgetCallsAtStart, `${scenario.name}: widget stays registered`);
			assert.equal(
				h.renderRequests,
				rendersAtStart + 100,
				`${scenario.name}: only simulated external requests render while leased`,
			);
			if (scenario.error) throw scenario.error;
			return scenario.value;
		});

		let result;
		if (scenario.error) {
			await assert.rejects(
				execute(h.tools.get("exit_plan_mode"), { plan: "throw path" }, h.ctx),
				(error) => error === scenario.error,
			);
		} else {
			result = await execute(h.tools.get("exit_plan_mode"), { plan: `plan for ${scenario.name}` }, h.ctx);
			assert.match(resultText(result), scenario.expected);
		}
		assert.deepEqual(h.workingVisibleCalls, [false, true], `${scenario.name}: working false→true`);
		assert.equal(h.activeCustom, 0, `${scenario.name}: no custom focus remains`);
		assert.deepEqual(
			h.renderWidget(),
			["Tasks · revision 100", "Sub Agents", "└─ agent-99"],
			`${scenario.name}: outer release flushes latest Tasks→Sub Agents state`,
		);
		const rendersAfterDialog = h.renderRequests;
		h.activity.setActivityWidgetSection(h.ctx.ui, tasks, ["Tasks · after dialog"]);
		assert.equal(h.renderRequests, rendersAfterDialog + 1, `${scenario.name}: presentation lease was released`);
	}
});

test("working visibility failures are local and restoration never replaces dialog results or errors", async (t) => {
	const falseFailure = await harness(t);
	const owner = falseFailure.activity.createActivityWidgetOwner("tasks");
	falseFailure.activity.setActivityWidgetSection(falseFailure.ctx.ui, owner, ["Tasks old"]);
	falseFailure.setWorkingVisibleHook((visible) => {
		if (!visible) throw new Error("hide failed");
	});
	falseFailure.queueCustom(() => {
		falseFailure.activity.setActivityWidgetSection(falseFailure.ctx.ui, owner, ["Tasks latest"]);
		return null;
	});
	let result = await execute(falseFailure.tools.get("ask_user"), {
		question: "continue?",
		options: [{ label: "yes" }],
	}, falseFailure.ctx);
	assert.match(resultText(result), /取消/);
	assert.deepEqual(falseFailure.workingVisibleCalls, [false], "failed hide must not assume a restore is needed");
	assert.deepEqual(falseFailure.renderWidget(), ["Tasks latest"], "lease still releases after hide failure");

	const restoreFailure = await harness(t);
	restoreFailure.setWorkingVisibleHook((visible) => {
		if (visible) throw new Error("restore failed");
	});
	restoreFailure.queueCustom(null);
	result = await execute(restoreFailure.tools.get("ask_user"), {
		question: "continue?",
		options: [{ label: "yes" }],
	}, restoreFailure.ctx);
	assert.match(resultText(result), /取消/);
	assert.deepEqual(restoreFailure.workingVisibleCalls, [false, true]);

	const originalError = new Error("original custom failure");
	const errorRestoreFailure = await harness(t);
	errorRestoreFailure.setWorkingVisibleHook((visible) => {
		if (visible) throw new Error("restore must stay secondary");
	});
	errorRestoreFailure.queueCustom(() => { throw originalError; });
	await assert.rejects(
		execute(errorRestoreFailure.tools.get("ask_user"), {
			question: "continue?",
			options: [{ label: "yes" }],
		}, errorRestoreFailure.ctx),
		(error) => error === originalError,
	);
	assert.deepEqual(errorRestoreFailure.workingVisibleCalls, [false, true]);
	assert.equal(errorRestoreFailure.activeCustom, 0);
});

test("RPC ask/approval paths never touch TUI working visibility or presentation leases", async (t) => {
	const h = await harness(t);
	h.ctx.mode = "rpc";
	let result = await execute(h.tools.get("ask_user"), {
		question: "unavailable",
		options: [{ label: "one" }],
	}, h.ctx);
	assert.match(resultText(result), /interactive UI not available/i);

	await execute(h.tools.get("enter_plan_mode"), { reason: "rpc approval" }, h.ctx);
	h.queueConfirm(true);
	result = await execute(h.tools.get("exit_plan_mode"), { plan: "RPC plan" }, h.ctx);
	assert.match(resultText(result), /approved/i);
	assert.deepEqual(h.workingVisibleCalls, []);
	assert.deepEqual(h.uiCalls, { custom: 0, confirm: 1, input: 0 });
});
