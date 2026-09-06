import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { CODEX_FAST_EVENT, CODEX_FAST_MARKER_TYPE } from "./fast-mode.ts";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBusModule = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const extensionPath = new URL("./index.ts", import.meta.url).pathname;

async function harness() {
	const entries = [];
	const notifications = [];
	const statuses = [];
	const events = [];
	let thinking = "low";
	const runtime = loader.createExtensionRuntime();
	runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
	runtime.getThinkingLevel = () => thinking;
	runtime.setThinkingLevel = (level) => { thinking = level; };
	const eventBus = eventBusModule.createEventBus();
	eventBus.on(CODEX_FAST_EVENT, (payload) => events.push(payload));
	const loaded = await loader.loadExtensions([extensionPath], process.cwd(), eventBus, runtime);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const ctx = {
		model: { provider: "openai-codex", id: "gpt-5.6-sol" },
		hasUI: true,
		sessionManager: { getBranch: () => entries },
		ui: {
			theme: { fg: (_tone, text) => text },
			setStatus: (key, value) => statuses.push({ key, value }),
			notify: (message, kind) => notifications.push({ message, kind }),
		},
	};
	const fire = async (name, payload = {}) => {
		for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...payload }, ctx);
	};
	return {
		entries,
		notifications,
		statuses,
		events,
		ctx,
		fire,
		fast: extension.commands.get("fast").handler,
		getThinking: () => thinking,
		setThinking: (level) => { thinking = level; },
	};
}

test("/fast toggles current-session state, persists markers and emits statusline events", async () => {
	const h = await harness();
	await h.fire("session_start", { reason: "startup" });
	assert.equal(h.events.at(-1).active, false);

	await h.fast("on", h.ctx);
	assert.equal(h.entries.at(-1).customType, CODEX_FAST_MARKER_TYPE);
	assert.equal(h.entries.at(-1).data.enabled, true);
	assert.equal(h.events.at(-1).active, true);
	assert.equal(h.statuses.at(-1).value, "⚡ FAST");
	assert.match(h.notifications.at(-1).message, /2\.5× ChatGPT credits/);

	await h.fast("status", h.ctx);
	assert.match(h.notifications.at(-1).message, /priority/);
	assert.match(h.notifications.at(-1).message, /1\.5× speed/);

	await h.fast("", h.ctx);
	assert.equal(h.entries.at(-1).data.enabled, false);
	assert.equal(h.events.at(-1).active, false);
	assert.equal(h.statuses.at(-1).value, undefined);
	assert.match(h.notifications.at(-1).message, /Standard service tier/);
	await h.fire("session_shutdown", { reason: "quit" });
});

test("session_start restores an enabled marker and immediately updates the statusline", async () => {
	const h = await harness();
	h.entries.push({ type: "custom", customType: CODEX_FAST_MARKER_TYPE, data: { enabled: true, timestamp: 1 } });
	await h.fire("session_start", { reason: "resume" });
	assert.equal(h.events.at(-1).active, true);
	assert.equal(h.statuses.at(-1).value, "⚡ FAST");
	await h.fire("session_shutdown", { reason: "quit" });
});

test("unsupported models cannot enable Fast, while model_select preserves user effort", async () => {
	const h = await harness();
	await h.fire("session_start", { reason: "startup" });
	h.ctx.model = { provider: "openai-codex", id: "gpt-5.4-mini" };
	const before = h.entries.length;
	await h.fast("on", h.ctx);
	assert.equal(h.entries.length, before);
	assert.match(h.notifications.at(-1).message, /only for supported Codex OAuth models/);

	h.ctx.model = { provider: "openai-codex-second", id: "gpt-5.6-terra" };
	await h.fire("model_select", { model: h.ctx.model, previousModel: undefined, source: "set" });
	assert.equal(h.getThinking(), "low");
	await h.fast("on", h.ctx);
	assert.equal(h.events.at(-1).provider, "openai-codex-second");
	assert.equal(h.events.at(-1).active, true);
	for (const provider of ["openai-codex", "openai-codex-second"]) {
		for (const level of ["low", "medium", "high", "xhigh"]) {
			h.setThinking(level);
			h.ctx.model = { provider, id: "gpt-5.6-terra" };
			const count = h.events.length;
			await h.fire("model_select", { model: h.ctx.model, source: "set" });
			assert.equal(h.getThinking(), level);
			assert.equal(h.events.length, count + 1);
			assert.equal(h.events.at(-1).provider, provider);
			assert.equal(h.events.at(-1).active, true);
		}
	}
	await h.fire("session_shutdown", { reason: "quit" });
});
