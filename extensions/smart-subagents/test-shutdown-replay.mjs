import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import {
	SHUTDOWN_REPLAY_LIMITS,
	SHUTDOWN_REPLAY_REASON,
	scanShutdownCompletionReplay,
} from "./shutdown-replay.ts";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBusModule = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));

const fixtureRoute = {
	modelRef: "fixture/worker",
	provider: "fixture",
	modelId: "worker",
	modelName: "fixture worker",
	providerName: "fixture provider",
	effort: "low",
	contextMode: "isolated",
	permission: "read-only",
	complexity: "medium",
	reason: "fixture route reason",
	contextSummary: "PRIVATE ROUTE CONTEXT",
};

function stateData(id = "fixture-job", overrides = {}) {
	return {
		id,
		name: `job_${id.replace(/[^a-z0-9]+/gi, "_")}`,
		task: "PRIVATE TASK THAT MUST NOT BE REPLAYED",
		expectedOutput: "PRIVATE EXPECTED OUTPUT",
		status: "running",
		route: { ...fixtureRoute },
		contextFiles: ["/private/context.md"],
		writeScope: ["/private/write-scope"],
		cwd: "/private/worktree",
		createdAt: 1,
		startedAt: 2,
		changedFiles: ["private-change.ts"],
		attemptedModels: ["fixture/worker"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		output: "PRIVATE OUTPUT",
		error: "PRIVATE ERROR",
		logPath: "/private/result.json",
		progress: ["PRIVATE PROGRESS"],
		...overrides,
	};
}

function stateEntry(data) {
	return { type: "custom", customType: "smart-subagent-state", data };
}

function shutdownEntry(id = "fixture-job", overrides = {}) {
	return stateEntry(stateData(id, {
		status: "stopped",
		finishedAt: 3,
		exitCode: 143,
		signal: "SIGTERM",
		terminationReason: "session_shutdown",
		...overrides,
	}));
}

function stoppedFixture(id = "fixture-job", overrides = {}) {
	const active = stateData(id, { output: undefined, error: undefined, ...overrides });
	return [
		stateEntry(active),
		stateEntry({
			...active,
			status: "stopped",
			finishedAt: 3,
			exitCode: 143,
			signal: "SIGTERM",
			terminationReason: "session_shutdown",
			error: "stopped during session shutdown",
		}),
	];
}

function completionEntry(id, event = "stopped", status = event) {
	return {
		type: "custom_message",
		customType: "smart-subagent-completion",
		content: "persisted completion",
		display: true,
		details: {
			event,
			job: { id, name: `job_${id}`, status },
		},
	};
}

function persistedSentMessage(message) {
	return {
		type: "custom_message",
		customType: message.customType,
		content: message.content,
		display: message.display,
		details: message.details,
	};
}

async function harness(entries, options = {}) {
	const messages = [];
	const sendAttempts = [];
	const notifications = [];
	const runtime = loader.createExtensionRuntime();
	runtime.appendEntry = (customType, data) => entries.push({ type: "custom", customType, data });
	runtime.sendMessage = (message, sendOptions) => {
		sendAttempts.push({ message, options: sendOptions });
		if (options.throwSendAttempts?.has(sendAttempts.length)) throw new Error(`send failure ${sendAttempts.length}`);
		messages.push({ message, options: sendOptions });
		if (options.persistOnSend) entries.push(persistedSentMessage(message));
	};
	const loaded = await loader.loadExtensions(
		[extensionPath],
		options.cwd ?? process.cwd(),
		eventBusModule.createEventBus(),
		runtime,
	);
	assert.deepEqual(loaded.errors, []);
	const extension = loaded.extensions[0];
	const ctx = {
		cwd: options.cwd ?? process.cwd(),
		hasUI: options.hasUI ?? false,
		model: undefined,
		scopedModels: [],
		modelRegistry: {},
		sessionManager: {
			getSessionId: () => options.getSessionId?.() ?? options.sessionId ?? "fixture-session",
			getBranch: () => options.getBranch?.() ?? entries,
		},
		ui: {
			notify(message, kind) { notifications.push({ message, kind }); },
		},
	};
	return {
		entries,
		messages,
		sendAttempts,
		notifications,
		async fire(name) {
			for (const handler of extension.handlers.get(name) ?? []) {
				await handler({ type: name, reason: name === "session_shutdown" ? "quit" : "startup" }, ctx);
			}
		},
	};
}

async function withWebSession(value, callback) {
	const hadValue = Object.hasOwn(process.env, "PI_WEB_SESSION");
	const priorValue = process.env.PI_WEB_SESSION;
	if (value === undefined) delete process.env.PI_WEB_SESSION;
	else process.env.PI_WEB_SESSION = value;
	try {
		return await callback();
	} finally {
		if (hadValue) process.env.PI_WEB_SESSION = priorValue;
		else delete process.env.PI_WEB_SESSION;
	}
}

function replayMessages(runtime) {
	return runtime.messages.filter(({ message }) => (
		message.customType === "smart-subagent-completion" && message.details?.event === "stopped"
	));
}

test("pure scanner returns a privacy-minimal, bounded shutdown snapshot", () => {
	const result = scanShutdownCompletionReplay([shutdownEntry()]);
	assert.equal(result.candidates.length, 1);
	const [job] = result.candidates;
	assert.deepEqual(job, {
		id: "fixture-job",
		name: "job_fixture_job",
		status: "stopped",
		createdAt: 1,
		startedAt: 2,
		finishedAt: 3,
		terminationReason: "session_shutdown",
		error: SHUTDOWN_REPLAY_REASON,
		route: {
			modelRef: "fixture/worker",
			provider: "fixture",
			modelId: "worker",
			modelName: "fixture worker",
			providerName: "fixture provider",
			effort: "low",
			contextMode: "isolated",
			permission: "read-only",
			complexity: "medium",
		},
	});
	const serialized = JSON.stringify(job);
	for (const secret of [
		"PRIVATE TASK", "PRIVATE EXPECTED", "PRIVATE ROUTE CONTEXT", "PRIVATE OUTPUT",
		"PRIVATE ERROR", "PRIVATE PROGRESS", "/private/", "private-change.ts",
	]) {
		assert.ok(!serialized.includes(secret), `replay snapshot leaked ${secret}`);
	}
	for (const forbidden of [
		"task", "expectedOutput", "cwd", "contextFiles", "writeScope", "output",
		"logPath", "progress", "changedFiles", "attemptedModels", "usage",
	]) {
		assert.equal(Object.hasOwn(job, forbidden), false, `${forbidden} must not be copied`);
	}
});

test("route may be absent, while malformed route fields and enums fail closed", () => {
	const routeMissing = scanShutdownCompletionReplay([shutdownEntry("routing-job", { route: undefined })]);
	assert.equal(routeMissing.candidates.length, 1);
	assert.equal(Object.hasOwn(routeMissing.candidates[0], "route"), false);

	const malformedRoutes = [
		{ ...fixtureRoute, providerName: "provider\u001b[31m" },
		{ ...fixtureRoute, effort: "unbounded" },
		{ ...fixtureRoute, contextMode: "everything" },
		{ ...fixtureRoute, permission: "root" },
		{ ...fixtureRoute, modelRef: "other/worker" },
	];
	for (const [index, route] of malformedRoutes.entries()) {
		const result = scanShutdownCompletionReplay([shutdownEntry(`bad-route-${index}`, { route })]);
		assert.deepEqual(result.candidates, []);
	}
});

test("valid completion acknowledgements suppress replay; inconsistent event/status does not", () => {
	const entries = stoppedFixture("acked-job");
	const acked = scanShutdownCompletionReplay([...entries, completionEntry("acked-job")]);
	assert.deepEqual(acked.candidates, []);
	assert.deepEqual(acked.deliveredIds, ["acked-job"]);

	for (const acknowledgement of [
		completionEntry("acked-job", "stopped", "failed"),
		completionEntry("acked-job", "failed", "stopped"),
		completionEntry("acked-job", "progress", "progress"),
		{ ...completionEntry("acked-job"), details: { event: "stopped", job: { id: "bad\njob", status: "stopped" } } },
	]) {
		const result = scanShutdownCompletionReplay([...entries, acknowledgement]);
		assert.equal(result.candidates.length, 1);
		assert.deepEqual(result.deliveredIds, []);
	}
});

test("only the latest state per id is eligible, with latest-state branch ordering", () => {
	for (const later of [
		stateEntry(stateData("latest-job", { status: "routing", startedAt: undefined })),
		stateEntry(stateData("latest-job", { status: "queued" })),
		stateEntry(stateData("latest-job", { status: "running" })),
		stateEntry(stateData("latest-job", { status: "completed", finishedAt: 4, terminationReason: "completed" })),
		stateEntry(stateData("latest-job", { status: "failed", finishedAt: 4, terminationReason: "exit_nonzero" })),
		stateEntry(stateData("latest-job", { status: "stopped", finishedAt: 4, terminationReason: "explicit_stop" })),
	]) {
		assert.deepEqual(scanShutdownCompletionReplay([shutdownEntry("latest-job"), later]).candidates, []);
	}

	const ordered = scanShutdownCompletionReplay([
		shutdownEntry("a"),
		shutdownEntry("b"),
		shutdownEntry("a", { finishedAt: 4 }),
	]);
	assert.deepEqual(ordered.candidates.map((job) => job.id), ["b", "a"]);
});

test("multiple candidates preserve order and are capped at 64", () => {
	const entries = Array.from(
		{ length: SHUTDOWN_REPLAY_LIMITS.maxCandidates + 9 },
		(_, index) => shutdownEntry(`job-${String(index).padStart(3, "0")}`),
	);
	const result = scanShutdownCompletionReplay(entries);
	assert.equal(result.candidates.length, 64);
	assert.deepEqual(
		result.candidates.map((job) => job.id),
		Array.from({ length: 64 }, (_, index) => `job-${String(index).padStart(3, "0")}`),
	);
});

test("malformed, oversized, control-bearing, cyclic, and over-budget states never replay", () => {
	const oversizedField = "x".repeat(SHUTDOWN_REPLAY_LIMITS.maxStringBytes + 1);
	const oversizedPath = `/${"p".repeat(SHUTDOWN_REPLAY_LIMITS.maxPathBytes + 1)}`;
	const oversizedArray = Array.from({ length: SHUTDOWN_REPLAY_LIMITS.maxArrayItems + 1 }, () => "x");
	const cases = [
		shutdownEntry("bad-name", { name: "bad\nname" }),
		shutdownEntry("path-name", { name: "../private" }),
		shutdownEntry("bad-id\n", {}),
		shutdownEntry("bad-time", { finishedAt: -1 }),
		shutdownEntry("bad-order", { startedAt: 4, finishedAt: 3 }),
		shutdownEntry("big-field", { task: oversizedField }),
		shutdownEntry("big-path", { contextFiles: [oversizedPath] }),
		shutdownEntry("big-array", { progress: oversizedArray }),
	];
	for (const entry of cases) {
		assert.doesNotThrow(() => scanShutdownCompletionReplay([entry]));
		assert.deepEqual(scanShutdownCompletionReplay([entry]).candidates, []);
	}

	const oldThenMalformed = [
		shutdownEntry("same-id"),
		shutdownEntry("same-id", { name: "later\u0000malformed" }),
	];
	assert.deepEqual(scanShutdownCompletionReplay(oldThenMalformed).candidates, []);
	const unrelatedMalformed = scanShutdownCompletionReplay([
		shutdownEntry("still-valid"),
		stateEntry({ id: "bad/id", status: "stopped" }),
	]);
	assert.deepEqual(unrelatedMalformed.candidates.map((job) => job.id), ["still-valid"]);

	const cyclic = stateData("cyclic", {
		status: "stopped",
		finishedAt: 3,
		terminationReason: "session_shutdown",
	});
	cyclic.loop = cyclic;
	assert.deepEqual(scanShutdownCompletionReplay([stateEntry(cyclic)]).candidates, []);

	const chunk = "z".repeat(SHUTDOWN_REPLAY_LIMITS.maxStringBytes - 128);
	const overTotal = [];
	const count = Math.ceil(SHUTDOWN_REPLAY_LIMITS.maxTotalBytes / chunk.length) + 2;
	for (let index = 0; index < count; index++) {
		overTotal.push(stateEntry(stateData(`budget-${index}`, {
			status: "completed",
			finishedAt: 3,
			terminationReason: "completed",
			output: chunk,
		})));
	}
	overTotal.push(shutdownEntry("after-budget"));
	assert.deepEqual(scanShutdownCompletionReplay(overTotal).candidates, []);
});

test("scanner uses only explicit state/message entries on the supplied active branch", () => {
	const hidden = stateData("hidden", {
		status: "stopped",
		finishedAt: 3,
		terminationReason: "session_shutdown",
	});
	const result = scanShutdownCompletionReplay([
		{ type: "compaction", summary: "summary", details: { state: hidden } },
		{ type: "custom", customType: "other-state", data: hidden },
		shutdownEntry("visible"),
	]);
	assert.deepEqual(result.candidates.map((job) => job.id), ["visible"]);
});

test("replays exactly one stopped completion after session shutdown recovery", async () => {
	await withWebSession("0", async () => {
		const priorRuntime = await harness([]);
		await priorRuntime.fire("session_start");
		priorRuntime.entries.push(...stoppedFixture());
		await priorRuntime.fire("session_shutdown");

		const restoredRuntime = await harness(priorRuntime.entries);
		try {
			await restoredRuntime.fire("session_start");
			const completions = replayMessages(restoredRuntime);
			assert.equal(
				restoredRuntime.messages.length,
				1,
				`expected exactly one stopped completion after recovery; received ${restoredRuntime.messages.length}`,
			);
			assert.equal(completions.length, 1, "the replayed completion must have event=stopped");
			assert.match(completions[0].message.content, /previous session shutdown/);
			assert.ok(!completions[0].message.content.includes("PRIVATE"));
		} finally {
			await restoredRuntime.fire("session_shutdown");
		}
	});
});

test("repeated start is idempotent and a persisted message prevents replay in a new runtime", async () => {
	await withWebSession("0", async () => {
		const entries = stoppedFixture("once-job");
		const runtime = await harness(entries);
		await runtime.fire("session_start");
		await runtime.fire("session_start");
		assert.equal(replayMessages(runtime).length, 1);

		entries.push(persistedSentMessage(runtime.messages[0].message));
		const restored = await harness(entries);
		await restored.fire("session_start");
		await restored.fire("session_start");
		assert.equal(restored.messages.length, 0);
		await runtime.fire("session_shutdown");
		await restored.fire("session_shutdown");
	});
});

test("a synchronous send throw releases the claim for the next session_start retry", async () => {
	await withWebSession("0", async () => {
		const runtime = await harness(stoppedFixture("retry-job"), {
			throwSendAttempts: new Set([1]),
		});
		await runtime.fire("session_start");
		assert.equal(runtime.sendAttempts.length, 1);
		assert.equal(runtime.messages.length, 0);
		assert.match(runtime.notifications[0].message, /send failure 1/);
		await runtime.fire("session_start");
		assert.equal(runtime.sendAttempts.length, 2);
		assert.equal(replayMessages(runtime).length, 1);
		await runtime.fire("session_shutdown");
	});
});

test("busy-parent replay is delivered at agent_end only after send succeeds", async () => {
	await withWebSession("0", async () => {
		const runtime = await harness(stoppedFixture("deferred-job"));
		await runtime.fire("agent_start");
		await runtime.fire("session_start");
		await runtime.fire("session_start");
		assert.equal(runtime.sendAttempts.length, 0);
		await runtime.fire("agent_end");
		assert.equal(replayMessages(runtime).length, 1);
		await runtime.fire("agent_end");
		assert.equal(runtime.sendAttempts.length, 1);
		await runtime.fire("session_shutdown");
	});
});

test("a deferred send throw releases the claim for a later start retry", async () => {
	await withWebSession("0", async () => {
		const runtime = await harness(stoppedFixture("deferred-retry-job"), {
			throwSendAttempts: new Set([1]),
		});
		await runtime.fire("agent_start");
		await runtime.fire("session_start");
		await runtime.fire("agent_end");
		assert.equal(runtime.sendAttempts.length, 1);
		assert.equal(runtime.messages.length, 0);
		await runtime.fire("session_start");
		assert.equal(runtime.sendAttempts.length, 2);
		assert.equal(replayMessages(runtime).length, 1);
		await runtime.fire("session_shutdown");
	});
});

test("shutdown abandons deferred claims so the next start can replay", async () => {
	await withWebSession("0", async () => {
		const runtime = await harness(stoppedFixture("abandoned-job"));
		await runtime.fire("agent_start");
		await runtime.fire("session_start");
		assert.equal(runtime.sendAttempts.length, 0);
		await runtime.fire("session_shutdown");
		await runtime.fire("agent_end");
		assert.equal(runtime.sendAttempts.length, 0);
		await runtime.fire("session_start");
		assert.equal(replayMessages(runtime).length, 1);
		await runtime.fire("session_shutdown");
	});
});

test("multiple recovered jobs are sent one-by-one in latest-state order and capped", async () => {
	await withWebSession("0", async () => {
		const entries = Array.from(
			{ length: SHUTDOWN_REPLAY_LIMITS.maxCandidates + 3 },
			(_, index) => shutdownEntry(`send-${String(index).padStart(3, "0")}`),
		);
		// Updating the first id moves its delivery position past the 64-item cap.
		entries.push(shutdownEntry("send-000", { finishedAt: 4 }));
		const runtime = await harness(entries);
		await runtime.fire("session_start");
		assert.equal(replayMessages(runtime).length, 64);
		assert.deepEqual(
			replayMessages(runtime).map(({ message }) => message.details.job.id),
			Array.from({ length: 64 }, (_, index) => `send-${String(index + 1).padStart(3, "0")}`),
		);
		await runtime.fire("session_shutdown");
	});
});

test("completion acknowledgement is isolated to its active branch/fork", async () => {
	await withWebSession("0", async () => {
		const shared = stoppedFixture("fork-job");
		const mainBranch = [...shared, completionEntry("fork-job")];
		const forkBranch = [...shared, { type: "message", id: "fork-tail", message: { role: "user", content: "fork" } }];
		let activeBranch = mainBranch;
		const runtime = await harness([], { getBranch: () => activeBranch });
		await runtime.fire("session_start");
		assert.equal(runtime.messages.length, 0);
		activeBranch = forkBranch;
		await runtime.fire("session_start");
		assert.equal(replayMessages(runtime).length, 1);
		activeBranch = mainBranch;
		await runtime.fire("session_start");
		assert.equal(runtime.messages.length, 1);
		await runtime.fire("session_shutdown");
	});
});

test("runtime delivery claims are isolated when the active session changes", async () => {
	await withWebSession("0", async () => {
		let sessionId = "session-one";
		const runtime = await harness(stoppedFixture("cross-session-job"), {
			getSessionId: () => sessionId,
		});
		await runtime.fire("session_start");
		assert.equal(replayMessages(runtime).length, 1);
		sessionId = "session-two";
		await runtime.fire("session_start");
		assert.equal(replayMessages(runtime).length, 2);
		await runtime.fire("session_shutdown");
	});
});

test("replay stays synchronous and non-UI under native and PI WEB markers", async (t) => {
	for (const marker of [undefined, "0", "1"]) {
		await t.test(`PI_WEB_SESSION=${marker ?? "unset"}`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "smart-subagent-replay-web-"));
			try {
				await withWebSession(marker, async () => {
					const runtime = await harness(stoppedFixture(`web-${marker ?? "unset"}`), {
						cwd: directory,
						hasUI: false,
						sessionId: `fixture-${marker ?? "unset"}`,
					});
					await runtime.fire("session_start");
					assert.equal(replayMessages(runtime).length, 1);
					// PI WEB registry startup is intentionally after replay and async.
					await new Promise((resolve) => setTimeout(resolve, marker === "1" ? 300 : 20));
					await runtime.fire("session_shutdown");
					await new Promise((resolve) => setTimeout(resolve, marker === "1" ? 100 : 0));
				});
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		});
	}
});
