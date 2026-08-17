/**
 * Regression tests for session-sync drift detection.
 *
 * Covers the distinction between local persisted state changes and external
 * session-file growth. Local model/thinking changes must refresh the watcher
 * baseline; external phone/web writes must still require /sync.
 *
 * Run: node --experimental-strip-types extensions/session-sync/test-drift.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAST_POLL_MS = 40;
const FAST_QUIET_MS = 80;
const WAIT_TIMEOUT_MS = 1_000;

class MockUI {
	widgets = new Map();
	notifications = [];
	setWidget(key, lines) { this.widgets.set(key, lines); }
	notify(msg, type) { this.notifications.push({ msg, type }); }
}

class MockSessionManager {
	constructor(file) { this.file = file; }
	getSessionFile() { return this.file; }
}

class MockCtx {
	constructor(file) {
		this.ui = new MockUI();
		this.sessionManager = new MockSessionManager(file);
		this.mode = "tui";
	}
	isIdle() { return true; }
	async waitForIdle() {}
	async switchSession(file) { this.switchedTo = file; }
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, message) {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(10);
	}
	assert.fail(message);
}

const dir = mkdtempSync(join(tmpdir(), "pi-drift-test-"));
const sessionFile = join(dir, "test-session.jsonl");
const header = {
	type: "session",
	version: 3,
	id: "test",
	timestamp: new Date().toISOString(),
	cwd: dir,
};
writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);

const { createSessionSyncExtension } = await import("./index.ts");
const factory = createSessionSyncExtension({
	pollIntervalMs: FAST_POLL_MS,
	quietPeriodMs: FAST_QUIET_MS,
	minDriftBytes: 16,
});

const handlers = new Map();
const commands = new Map();
const mockPi = {
	on: (event, handler) => {
		const list = handlers.get(event) ?? [];
		list.push(handler);
		handlers.set(event, list);
	},
	registerCommand: (name, options) => commands.set(name, options),
};

factory(mockPi);

async function fire(event, payload = {}) {
	for (const handler of handlers.get(event) ?? []) {
		await handler({ type: event, ...payload }, ctx);
	}
}

function append(entry) {
	writeFileSync(sessionFile, `${JSON.stringify(entry)}\n`, { flag: "a" });
}

const ctx = new MockCtx(sessionFile);
await fire("session_start");
assert.ok(handlers.get("model_select")?.length, "model_select must be tracked as local activity");
assert.ok(handlers.get("thinking_level_select")?.length, "thinking_level_select must be tracked as local activity");
console.log("✓ session watcher registered local model/thinking activity");

// Match Pi's real order: persist the entry first, then emit the extension event.
await sleep(FAST_QUIET_MS + FAST_POLL_MS);
append({
	type: "model_change",
	id: "model001",
	parentId: null,
	timestamp: new Date().toISOString(),
	provider: "opencode-go",
	modelId: "deepseek-v4-flash",
});
await fire("model_select", { model: { provider: "opencode-go", id: "deepseek-v4-flash" } });
await sleep(FAST_QUIET_MS + FAST_POLL_MS);
assert.equal(ctx.ui.widgets.has("session-drift"), false, "local model switch must not look external");
console.log("✓ local model switch does not trigger /sync warning");

await sleep(FAST_QUIET_MS + FAST_POLL_MS);
append({
	type: "thinking_level_change",
	id: "think001",
	parentId: "model001",
	timestamp: new Date().toISOString(),
	thinkingLevel: "max",
});
await fire("thinking_level_select", { level: "max", previousLevel: "high" });
await sleep(FAST_QUIET_MS + FAST_POLL_MS);
assert.equal(ctx.ui.widgets.has("session-drift"), false, "local thinking switch must not look external");
console.log("✓ local thinking switch does not trigger /sync warning");

// A write with no local event is still external drift and must fail closed.
await sleep(FAST_QUIET_MS + FAST_POLL_MS);
append({
	type: "message",
	id: "external001",
	parentId: "think001",
	timestamp: new Date().toISOString(),
	message: { role: "user", content: "Message from phone", timestamp: Date.now() },
});
await waitFor(() => ctx.ui.widgets.has("session-drift"), "external write should trigger drift warning");
assert.match(ctx.ui.widgets.get("session-drift").join("\n"), /Run \/sync/);
console.log("✓ external phone/web write still triggers /sync warning");

const syncCommand = commands.get("sync");
assert.ok(syncCommand, "/sync command not registered");
assert.equal(typeof syncCommand.handler, "function", "/sync handler is not a function");
await syncCommand.handler("", ctx);
assert.equal(ctx.switchedTo, sessionFile, "/sync should switch to the current session file");
console.log("✓ /sync reloads the current session file");

const busyCtx = new MockCtx(sessionFile);
busyCtx.isIdle = () => false;
await syncCommand.handler("", busyCtx);
assert.ok(busyCtx.ui.notifications.some((notification) => notification.type === "warning"));
assert.equal(busyCtx.switchedTo, undefined, "/sync must not switch while busy");
console.log("✓ /sync refuses while the agent is busy");

const ephemeralCtx = new MockCtx(undefined);
await syncCommand.handler("", ephemeralCtx);
assert.ok(ephemeralCtx.ui.notifications.some((notification) => notification.type === "warning"));
console.log("✓ /sync handles ephemeral sessions");

await fire("session_shutdown");
rmSync(dir, { recursive: true, force: true });
console.log("✓ session shutdown clears the watcher");
console.log("\n✓ All session-sync tests passed");
