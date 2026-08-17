import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { buildWebAgentsRecord, buildWebRuntimeRecord, isWebActivityStartCurrent } from "./web-record.ts";

const identity = { sessionId: "sess-1", runtimeId: "rt-1", generation: 2, controlToken: "tok-1" };

function job(id, overrides = {}) {
	return {
		id,
		name: `job-${id}`,
		status: "running",
		createdAt: 1000,
		startedAt: 2000,
		timeoutAt: 2_000_000,
		route: {
			modelRef: "openai-codex/gpt-5.4-mini",
			modelName: "gpt-5.4-mini",
			providerName: "OpenAI Codex",
			effort: "low",
			contextMode: "isolated",
			permission: "read-only",
		},
		progress: [],
		changedFiles: [],
		output: "done",
		error: undefined,
		logPath: "/tmp/x/result.json",
		// The full task text must never leak into the record, even if present.
		task: "FULL TASK TEXT THAT MUST NOT BE PERSISTED",
		expectedOutput: "SECRET EXPECTED OUTPUT",
		...overrides,
	};
}

test("record includes identity, timestamps, routing fields and queue positions", () => {
	const record = buildWebAgentsRecord(
		[job("a"), job("b", { status: "queued" }), job("c", { status: "completed", finishedAt: 5000 })],
		["b"],
		identity,
		9999,
	);
	assert.equal(record.schemaVersion, 1);
	assert.equal(record.sessionId, "sess-1");
	assert.equal(record.runtimeId, "rt-1");
	assert.equal(record.generation, 2);
	assert.equal(record.updatedAt, 9999);
	assert.equal(record.jobs.length, 3);

	const [a, b, c] = record.jobs;
	assert.equal(a.id, "a");
	assert.equal(a.queuePosition, undefined);
	assert.equal(b.queuePosition, 1);
	assert.equal(b.status, "queued");
	assert.equal(a.createdAt, 1000);
	assert.equal(a.startedAt, 2000);
	assert.equal(a.timeoutAt, 2_000_000);
	assert.equal(a.model, "openai-codex/gpt-5.4-mini");
	assert.equal(a.modelName, "gpt-5.4-mini");
	assert.equal(a.providerName, "OpenAI Codex");
	assert.equal(a.thinking, "low");
	assert.equal(a.context, "isolated");
	assert.equal(a.permission, "read-only");
	assert.equal(c.finishedAt, 5000);
});

test("record never persists the full task or parent context", () => {
	const record = buildWebAgentsRecord([job("a")], [], identity);
	const serialized = JSON.stringify(record);
	assert.ok(!serialized.includes("FULL TASK TEXT"));
	assert.ok(!serialized.includes("SECRET EXPECTED OUTPUT"));
	assert.ok(!("task" in record.jobs[0]));
});

test("stopping flag reflects stop requests and timeout escalation", () => {
	const record = buildWebAgentsRecord(
		[
			job("plain"),
			job("stopping", { stopRequest: "user" }),
			job("timing-out", { timedOutAt: 42 }),
			job("shutdown", { stopRequest: "shutdown" }),
		],
		[],
		identity,
	);
	assert.equal(record.jobs[0].stopping, false);
	assert.equal(record.jobs[1].stopping, true);
	assert.equal(record.jobs[2].stopping, true);
	assert.equal(record.jobs[3].stopping, true);
});

test("progress and changed files are bounded; summaries are truncated", () => {
	const record = buildWebAgentsRecord(
		[
			job("a", {
				progress: Array.from({ length: 30 }, (_, i) => `p${i}`),
				changedFiles: Array.from({ length: 120 }, (_, i) => `f${i}.ts`),
				output: "z".repeat(5000),
				error: "e".repeat(5000),
				lastOutputAt: 7000,
				lastProgressAt: 8000,
			}),
		],
		[],
		identity,
	);
	const [a] = record.jobs;
	assert.equal(a.progress.length, 8);
	assert.deepEqual(a.progress, Array.from({ length: 8 }, (_, i) => `p${22 + i}`));
	assert.equal(a.changedFiles.length, 50);
	assert.equal(a.changedFiles[0], "f70.ts");
	assert.equal(a.resultSummary.length, 2000);
	assert.equal(a.errorSummary.length, 1000);
	assert.equal(a.lastOutputAt, 7000);
	assert.equal(a.lastProgressAt, 8000);
	assert.equal(a.logPath, "/tmp/x/result.json");
});

test("runtime heartbeat carries source, control token and job counts, never a pid", () => {
	const record = buildWebRuntimeRecord(identity, "active", { startedAt: 100, total: 5, active: 3 }, 555);
	assert.equal(record.schemaVersion, 1);
	assert.equal(record.source, "smart-subagents");
	assert.equal(record.sessionId, "sess-1");
	assert.equal(record.runtimeId, "rt-1");
	assert.equal(record.generation, 2);
	assert.equal(record.controlToken, "tok-1");
	assert.equal(record.state, "active");
	assert.equal(record.startedAt, 100);
	assert.equal(record.updatedAt, 555);
	assert.equal(record.heartbeatAt, 555);
	assert.equal(record.pid, undefined);
	assert.deepEqual(record.jobs, { total: 5, active: 3 });
});

test("runtime shutdown state is written with source and a fresh heartbeat timestamp", () => {
	const record = buildWebRuntimeRecord(identity, "shutdown", { startedAt: 100, total: 0, active: 0 }, 999);
	assert.equal(record.state, "shutdown");
	assert.equal(record.source, "smart-subagents");
	assert.equal(record.updatedAt, 999);
	assert.equal(record.heartbeatAt, 999);
	assert.deepEqual(record.jobs, { total: 0, active: 0 });
});

test("startup guard rejects a late create after shutdown or a superseding epoch", () => {
	assert.equal(isWebActivityStartCurrent({ shuttingDown: false, epoch: 1, currentEpoch: 1 }), true);
	assert.equal(isWebActivityStartCurrent({ shuttingDown: true, epoch: 1, currentEpoch: 1 }), false);
	assert.equal(isWebActivityStartCurrent({ shuttingDown: false, epoch: 1, currentEpoch: 2 }), false);
	assert.equal(isWebActivityStartCurrent({ shuttingDown: true, epoch: 2, currentEpoch: 2 }), false);
});

test("index wires the repaired control and heartbeat contract", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

	// Control stop_one matches the exact job id only, never a colliding name.
	assert.match(source, /const job = jobs\.get\(jobId\)/);
	assert.doesNotMatch(source, /candidate\.name === jobId/);

	// The startup/shutdown race is guarded after the awaited create.
	assert.match(source, /isWebActivityStartCurrent\(\{ shuttingDown, epoch, currentEpoch: webStartEpoch \}\)/);

	// runtime.json heartbeats unconditionally every 5s (liveness), while agents
	// snapshots stay transition/progress based.
	assert.match(source, /flushWebRuntime\("active"\);\n\t\t\tif \(webProgressDirty\) flushWebAgents\(\);/);

	// Stale control files are pruned best-effort on startup.
	assert.match(source, /pruneOwnControlFiles\(\)\.catch/);

	// No PID is exposed to the web record.
	assert.doesNotMatch(source, /pid: process\.pid/);
});
