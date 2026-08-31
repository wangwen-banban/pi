import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBusModule = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

function stoppedFixture() {
	const active = {
		id: "fixture-job",
		name: "fixture_job",
		task: "sanitized fixture",
		status: "running",
		route: {
			modelRef: "fixture/worker",
			provider: "fixture",
			modelId: "worker",
			modelName: "fixture worker",
			providerName: "fixture provider",
			effort: "low",
			contextMode: "isolated",
			permission: "read-only",
		},
		contextFiles: [],
		writeScope: [],
		cwd: "",
		createdAt: 1,
		startedAt: 2,
		changedFiles: [],
		attemptedModels: ["fixture/worker"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		progress: [],
	};
	return [
		{ type: "custom", customType: "smart-subagent-state", data: active },
		{
			type: "custom",
			customType: "smart-subagent-state",
			data: {
				...active,
				status: "stopped",
				finishedAt: 3,
				exitCode: 143,
				signal: "SIGTERM",
				terminationReason: "session_shutdown",
				error: "stopped during session shutdown",
			},
		},
	];
}

async function harness(entries) {
	const messages = [];
	const runtime = loader.createExtensionRuntime();
	runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
	runtime.sendMessage = (message, options) => messages.push({ message, options });
	const loaded = await loader.loadExtensions(
		[extensionPath],
		process.cwd(),
		eventBusModule.createEventBus(),
		runtime,
	);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const ctx = {
		cwd: process.cwd(),
		hasUI: false,
		model: undefined,
		scopedModels: [],
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => "fixture-session",
			getBranch: () => entries,
		},
		ui: { notify() {} },
	};
	return {
		entries,
		messages,
		async fire(name) {
			for (const handler of extension.handlers.get(name) ?? []) {
				await handler({ type: name, reason: name === "session_shutdown" ? "quit" : "startup" }, ctx);
			}
		},
	};
}

const hadWebSession = Object.hasOwn(process.env, "PI_WEB_SESSION");
const webSession = process.env.PI_WEB_SESSION;

const replayShutdownCompletion = async () => {
	process.env.PI_WEB_SESSION = "0";
	try {
		const priorRuntime = await harness([]);
		await priorRuntime.fire("session_start");
		priorRuntime.entries.push(...stoppedFixture());
		await priorRuntime.fire("session_shutdown");

		const restoredRuntime = await harness(priorRuntime.entries);
		try {
			await restoredRuntime.fire("session_start");
			const completions = restoredRuntime.messages.filter(({ message }) => (
				message.customType === "smart-subagent-completion" && message.details?.event === "stopped"
			));
			assert.equal(
				restoredRuntime.messages.length,
				1,
				`expected exactly one stopped completion after recovery; received ${restoredRuntime.messages.length}`,
			);
			assert.equal(completions.length, 1, "the replayed completion must have event=stopped");
		} finally {
			await restoredRuntime.fire("session_shutdown");
		}
	} finally {
		if (hadWebSession) process.env.PI_WEB_SESSION = webSession;
		else delete process.env.PI_WEB_SESSION;
	}
};

if (process.env.PI_STRICT_KNOWN_BUGS === "1") {
	test("replays exactly one stopped completion after session shutdown recovery", replayShutdownCompletion);
} else {
	test.todo("replays exactly one stopped completion after session shutdown recovery");
}
