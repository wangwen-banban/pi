import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import {
	contextSnapshotResult,
	registerContextSnapshot,
} from "../extensions/shared/context-snapshot.ts";

const TYPE = "test:context:v1";
const stored = (content, customType = TYPE) => ({
	type: "custom_message", customType, content, display: false,
});
const manager = (entries = []) => ({ buildContextEntries: () => entries });
const messageOf = (entries, content = "A", type = TYPE) =>
	contextSnapshotResult(manager(entries), type, content).message;

function runtime(entries = []) {
	const handlers = new Map();
	const sent = [];
	const state = { entries };
	const ctx = { sessionManager: { buildContextEntries: () => state.entries } };
	const pi = {
		on(name, handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		sendMessage(message, options) {
			sent.push({ message, options });
			state.entries.push({ type: "custom_message", ...message });
		},
	};
	const emit = (name, event = {}) => (handlers.get(name) ?? []).map((fn) => fn(event, ctx));
	return { pi, ctx, state, handlers, sent, emit };
}

test("first snapshot is a hidden message, never a system-prompt override", () => {
	assert.deepEqual(contextSnapshotResult(manager(), TYPE, "A"), {
		message: { customType: TYPE, content: "A", display: false },
	});
});

test("unchanged latest snapshot does not append again", () => {
	assert.equal(messageOf([stored("A")]), undefined);
});

test("changed content is appended rather than rewriting old content", () => {
	const entries = Object.freeze([Object.freeze(stored("A"))]);
	assert.equal(messageOf(entries, "B").content, "B");
	assert.equal(entries[0].content, "A");
});

test("A -> B -> A compares only with B, not an older matching A", () => {
	assert.equal(messageOf([stored("A"), stored("B")]).content, "A");
});

test("snapshot custom types deduplicate independently", () => {
	assert.equal(messageOf([stored("B"), stored("A", "other:v1")]).content, "A");
	assert.equal(messageOf([stored("A"), stored("B", "other:v1")]), undefined);
});

test("durable custom state markers are not proof of model-visible state", () => {
	assert.equal(messageOf([{ type: "custom", customType: TYPE, content: "A", data: "A" }]).content, "A");
});

test("ordinary user messages cannot masquerade as extension snapshots", () => {
	const entries = [{ type: "message", message: { role: "user", customType: TYPE, content: "A" } }];
	assert.equal(messageOf(entries).content, "A");
});

test("serialized message-role custom snapshots are also recognized", () => {
	const entries = [{ type: "message", message: { role: "custom", customType: TYPE, content: "A" } }];
	assert.equal(messageOf(entries), undefined);
});

test("a malformed latest snapshot does not fall back to an older matching one", () => {
	assert.equal(messageOf([stored("A"), stored(null)]).content, "A");
});

test("non-snapshot tool and assistant messages do not force reinjection", () => {
	const entries = [stored("A"), { type: "message", message: { role: "toolResult", content: [] } },
		{ type: "message", message: { role: "assistant", content: [] } }];
	assert.equal(messageOf(entries), undefined);
});

test("compacted-away snapshots do not suppress a new snapshot", () => {
	const sm = {
		getEntries: () => [stored("A")],
		getBranch: () => [stored("A")],
		buildContextEntries: () => [{ type: "compaction", summary: "Earlier state summarized" }],
	};
	assert.equal(contextSnapshotResult(sm, TYPE, "A").message.content, "A");
});

test("a snapshot retained by compaction is not unnecessarily repeated", () => {
	assert.equal(messageOf([{ type: "compaction", summary: "older history" }, stored("A")]), undefined);
});

test("switching active branch cannot reuse a process-local last-sent value", () => {
	let active = [stored("A")];
	const sm = { buildContextEntries: () => active };
	assert.equal(contextSnapshotResult(sm, TYPE, "A").message, undefined);
	active = [stored("B")];
	assert.equal(contextSnapshotResult(sm, TYPE, "A").message.content, "A");
});

test("independent sessions cannot suppress each other's snapshots", () => {
	assert.equal(messageOf([stored("A")]), undefined);
	assert.equal(messageOf([]).content, "A");
});

test("an aborted preflight does not prematurely mark a snapshot as delivered", () => {
	const sm = manager();
	assert.ok(contextSnapshotResult(sm, TYPE, "A").message);
	assert.ok(contextSnapshotResult(sm, TYPE, "A").message);
});

test("failed context lookup conservatively returns current state", () => {
	const sm = { buildContextEntries() { throw new Error("context unavailable"); } };
	assert.equal(contextSnapshotResult(sm, TYPE, "A").message.content, "A");
});

test("registration uses normal prompts and compaction, not provider polling", () => {
	const r = runtime();
	registerContextSnapshot(r.pi, TYPE, () => "A");
	assert.deepEqual([...r.handlers.keys()], ["before_agent_start", "session_compact"]);
});

test("before_agent_start leaves the assembled system prompt untouched", () => {
	const r = runtime();
	registerContextSnapshot(r.pi, TYPE, () => "A");
	const event = Object.freeze({ systemPrompt: "base + other extension instructions" });
	const [result] = r.emit("before_agent_start", event);
	assert.equal(result.systemPrompt, undefined);
	assert.equal(event.systemPrompt, "base + other extension instructions");
	assert.equal(r.sent.length, 0, "Pi, not the helper, appends normal prompt messages");
});

test("compaction restores missing state without asking for a new model turn", () => {
	const r = runtime([{ type: "compaction", summary: "older messages" }]);
	registerContextSnapshot(r.pi, TYPE, () => "A");
	r.emit("session_compact", { willRetry: true, reason: "overflow" });
	assert.deepEqual(r.sent, [{ message: { customType: TYPE, content: "A", display: false },
		options: { triggerTurn: false } }]);
	assert.equal(r.emit("before_agent_start")[0].message, undefined);
});

test("compaction does not resend retained current state", () => {
	const r = runtime([stored("A")]);
	registerContextSnapshot(r.pi, TYPE, () => "A");
	r.emit("session_compact");
	assert.equal(r.sent.length, 0);
});

test("compaction restores a changed state even if an older snapshot remains", () => {
	const r = runtime([stored("A")]);
	registerContextSnapshot(r.pi, TYPE, () => "B");
	r.emit("session_compact");
	assert.equal(r.sent[0].message.content, "B");
	assert.equal(r.state.entries[0].content, "A");
});

test("reload deduplication comes from session entries, not an old closure", () => {
	const r1 = runtime();
	registerContextSnapshot(r1.pi, TYPE, () => "A");
	r1.emit("session_compact");
	const r2 = runtime(r1.state.entries);
	registerContextSnapshot(r2.pi, TYPE, () => "A");
	assert.equal(r2.emit("before_agent_start")[0].message, undefined);
});

test("current content is read at event time, not captured at registration", () => {
	const r = runtime([stored("A")]);
	let content = "A";
	registerContextSnapshot(r.pi, TYPE, () => content);
	assert.equal(r.emit("before_agent_start")[0].message, undefined);
	content = "B";
	assert.equal(r.emit("before_agent_start")[0].message.content, "B");
});

test("two registered snapshots neither overwrite nor suppress each other", () => {
	const r = runtime();
	registerContextSnapshot(r.pi, "tasks:v1", () => "revision 7");
	registerContextSnapshot(r.pi, "plan:v1", () => "active");
	const event = Object.freeze({ systemPrompt: "stable" });
	const results = r.emit("before_agent_start", event);
	assert.deepEqual(results.map((x) => x.message.content), ["revision 7", "active"]);
	assert.ok(results.every((x) => !Object.hasOwn(x, "systemPrompt")));
});

// Source-section regressions complement, but do not replace, the Pi suite.
const sourceRoot = resolve(process.env.PI_CACHE_FIX_SOURCE_ROOT ?? fileURLToPath(new URL("..", import.meta.url)));
function section(path, begin, end) {
	const source = readFileSync(resolve(sourceRoot, path), "utf8");
	const start = source.indexOf(begin);
	assert.notEqual(start, -1, `missing section start: ${path}`);
	assert.equal(source.indexOf(begin, start + begin.length), -1, `ambiguous section start: ${path}`);
	const stop = source.indexOf(end, start + begin.length);
	assert.notEqual(stop, -1, `missing section end: ${path}`);
	return source.slice(start, stop);
}
function installPlanSection(r, active, reason = "review architecture") {
	const code = section("extensions/plan-mode/index.ts",
		"\t// --- Keep dynamic plan-mode status out of the system prefix ---",
		"\t// --- Block write tools when in plan mode ---");
	const globals = { pi: r.pi, registerContextSnapshot, inPlanMode: active, planModeReason: reason };
	runInNewContext(code, globals);
	return globals;
}
function installTasksSection(r, revision = 7) {
	const code = section("extensions/background-tasks/index.ts",
		"\t// Keep dynamic revisions out of the system prefix.",
		"\tconst blockBranchChange =");
	const globals = { pi: r.pi, registerContextSnapshot, plan: { revision },
		taskPlanText: (plan) => `Task plan revision ${plan.revision}\n(no tasks)` };
	runInNewContext(code, globals);
	return globals;
}

test("plan hook reports active state and preserves incoming system instructions", () => {
	const r = runtime();
	installPlanSection(r, true);
	const [result] = r.emit("before_agent_start", { systemPrompt: "original instructions" });
	assert.equal(result.systemPrompt, undefined);
	assert.match(result.message.content, /PLAN MODE ACTIVE/);
	assert.match(result.message.content, /review architecture/);
	assert.match(result.message.content, /run_background_task.*BLOCKED/);
});

test("plan hook appends an explicit inactive state after active", () => {
	const r = runtime();
	const state = installPlanSection(r, true);
	const active = r.emit("before_agent_start")[0].message;
	r.state.entries.push({ type: "custom_message", ...active });
	state.inPlanMode = false;
	const inactive = r.emit("before_agent_start")[0].message;
	assert.match(inactive.content, /PLAN MODE INACTIVE/);
	assert.match(inactive.content, /other permissions and safeguards/);
	assert.equal(r.state.entries[0].content, active.content);
});

test("plan reason changes append state rather than modifying system prefix", () => {
	const r = runtime();
	const state = installPlanSection(r, true, "A");
	r.state.entries.push({ type: "custom_message", ...r.emit("before_agent_start")[0].message });
	state.planModeReason = "B";
	const result = r.emit("before_agent_start")[0];
	assert.match(result.message.content, /Plan reason: B/);
	assert.equal(result.systemPrompt, undefined);
});

test("inactive Plan Mode remains inactive after compaction restoration", () => {
	const r = runtime();
	installPlanSection(r, false);
	r.emit("session_compact", { willRetry: true });
	assert.match(r.sent[0].message.content, /PLAN MODE INACTIVE/);
	assert.equal(r.sent[0].options.triggerTurn, false);
});

test("task revisions append snapshots and preserve task-lifecycle instructions", () => {
	const r = runtime();
	const state = installTasksSection(r);
	const first = r.emit("before_agent_start")[0];
	assert.match(first.message.content, /Task plan revision 7/);
	assert.match(first.message.content, /never poll managed runs/);
	assert.equal(first.systemPrompt, undefined);
	r.state.entries.push({ type: "custom_message", ...first.message });
	assert.equal(r.emit("before_agent_start")[0].message, undefined);
	state.plan.revision = 8;
	assert.match(r.emit("before_agent_start")[0].message.content, /Task plan revision 8/);
});

test("task and plan hooks compose without overwriting system or each other", () => {
	const r = runtime();
	installTasksSection(r);
	installPlanSection(r, true);
	const event = Object.freeze({ systemPrompt: "base + safety + tool guidelines" });
	const result = r.emit("before_agent_start", event);
	assert.equal(result.length, 2);
	assert.ok(result.every((x) => x.message && !Object.hasOwn(x, "systemPrompt")));
	assert.notEqual(result[0].message.customType, result[1].message.customType);
});

test("model selection preserves thinking while still publishing Fast state", async () => {
	const code = section("extensions/provider-routing/index.ts",
		"  // Preserve the user's thinking level when switching providers/models.",
		'  pi.on("session_tree",');
	let handler;
	let published = 0;
	const pi = {
		on(name, fn) { assert.equal(name, "model_select"); handler = fn; },
		getThinkingLevel() { throw new Error("model_select must not inspect thinking level"); },
		setThinkingLevel() { throw new Error("model_select must not overwrite thinking level"); },
	};
	runInNewContext(code, { pi, publishFastMode: () => { published++; } });
	for (const provider of ["openai-codex", "openai-codex-second", "claude-custom"]) {
		await handler({ model: { provider } }, {});
	}
	assert.equal(published, 3);
});
