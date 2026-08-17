import assert from "node:assert/strict";
import test from "node:test";
import { buildBackgroundRuntimeRecord, buildBackgroundTasksRecord } from "./web-record.ts";

const identity = { sessionId: "session-1", runtimeId: "bg-runtime-1", generation: 2 };

test("background web records expose lifecycle metadata but no task text, command, output, credentials or pid", () => {
	const secretTaskText = "analyze unreleased customer benchmark";
	const secretCommand = "TOKEN=top-secret ./benchmark --customer hidden";
	const liveOutput = "private model output";
	const plan = {
		version: 1,
		revision: 7,
		reason: "private reason",
		updatedAt: 200,
		tasks: [{
			id: "benchmark",
			title: secretTaskText,
			status: "in_progress",
			updatedAt: 200,
			runId: "bg-run-1",
		}],
	};
	const run = {
		id: "bg-run-1",
		taskId: "benchmark",
		name: "benchmark_run",
		status: "running",
		cwd: "/private/workspace",
		createdAt: 100,
		startedAt: 110,
		timeoutAt: 1000,
		lastOutputAt: 150,
		stdoutTail: liveOutput,
		stderrTail: "",
		stdoutPath: "/private/stdout.log",
		stderrPath: "/private/stderr.log",
		resultPath: "/private/result.json",
		logTruncated: false,
		command: secretCommand,
		pid: 12345,
		apiKey: "top-secret",
	};
	const record = buildBackgroundTasksRecord(plan, [run], identity, 300);
	const serialized = JSON.stringify(record);
	assert.equal(serialized.includes(secretTaskText), false);
	assert.equal(serialized.includes(secretCommand), false);
	assert.equal(serialized.includes(liveOutput), false);
	assert.equal(serialized.includes("top-secret"), false);
	assert.equal(serialized.includes("12345"), false);
	assert.equal(serialized.includes("/private/"), false);
	assert.equal(record.revision, 7);
	assert.deepEqual(record.tasks[0], {
		id: "benchmark",
		name: "benchmark",
		status: "in_progress",
		position: 0,
		updatedAt: 200,
		runId: "bg-run-1",
	});
	assert.equal(record.runs[0].name, "benchmark_run");
});

test("runtime heartbeat identifies background source and shutdown omits heartbeat", () => {
	const active = buildBackgroundRuntimeRecord(identity, "active", { startedAt: 10, total: 3, active: 1 }, 20);
	assert.equal(active.source, "background-tasks");
	assert.equal(active.heartbeatAt, 20);
	assert.deepEqual(active.jobs, { total: 3, active: 1 });
	const shutdown = buildBackgroundRuntimeRecord(identity, "shutdown", { startedAt: 10, total: 3, active: 0 }, 30);
	assert.equal(Object.hasOwn(shutdown, "heartbeatAt"), false);
});
