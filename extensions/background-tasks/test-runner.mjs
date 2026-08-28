import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startManagedBackgroundRun } from "./runner.ts";

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-background-run-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function options(root, id, command, overrides = {}) {
	return {
		id,
		taskId: `task-${id}`,
		name: id,
		command,
		cwd: root,
		runDir: join(root, id),
		timeoutMs: 2_000,
		terminateGraceMs: 100,
		maxLogBytes: 1024,
		maxTailBytes: 256,
		shell: "/bin/sh",
		...overrides,
	};
}

test("managed run captures success, logs and a private durable result without a pid", async (t) => {
	const root = workspace(t);
	const updates = [];
	const controller = await startManagedBackgroundRun({
		...options(root, "success", "printf 'hello\\n'"),
		onUpdate: (snapshot) => updates.push(snapshot.status),
	});
	const result = await controller.completion;
	assert.equal(result.status, "completed");
	assert.equal(result.exitCode, 0);
	assert.equal(result.terminationReason, "completed");
	assert.match(result.stdoutTail, /hello/);
	assert.equal(readFileSync(result.stdoutPath, "utf8"), "hello\n");
	assert.equal(statSync(result.resultPath).mode & 0o777, 0o600);
	assert.equal(statSync(join(root, "success", "metadata.json")).mode & 0o777, 0o600);
	assert.equal(statSync(join(root, "success")).mode & 0o777, 0o700);
	const metadata = JSON.parse(readFileSync(join(root, "success", "metadata.json"), "utf8"));
	assert.equal(metadata.command, "printf 'hello\\n'");
	assert.equal(Object.hasOwn(metadata, "pid"), false);
	const persisted = JSON.parse(readFileSync(result.resultPath, "utf8"));
	assert.equal(Object.hasOwn(persisted, "pid"), false);
	assert.ok(updates.includes("running"));
	assert.ok(updates.includes("completed"));
});

test("non-zero exit and stderr are classified as failure", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(root, "nonzero", "printf 'bad\\n' >&2; exit 7"));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.exitCode, 7);
	assert.equal(result.terminationReason, "exit_nonzero");
	assert.match(result.stderrTail, /bad/);
});

test("external signal is a failure", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(root, "signal", "kill -TERM $$"));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "signal");
	assert.equal(result.signal, "SIGTERM");
});

test("timeout escalates an uncooperative process group and always settles", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(
		root,
		"timeout",
		"trap '' TERM; while :; do :; done",
		{ timeoutMs: 80, terminateGraceMs: 80 },
	));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "timed_out");
	assert.equal(result.timeoutEscalated, true);
	assert.equal(result.terminationEscalated, true);
	assert.equal(result.signal, "SIGKILL");
	assert.match(result.error, /timed out/);
});

test("explicit stop is idempotent and classified separately from failure", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(root, "stop", "while :; do sleep 1; done"));
	assert.equal(controller.stop("user"), true);
	assert.equal(controller.stop("user"), false);
	const result = await controller.completion;
	assert.equal(result.status, "stopped");
	assert.equal(result.terminationReason, "explicit_stop");
	assert.equal(result.stopReason, "user");
});

test("shutdown stop is distinguishable so the task plan can become blocked", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(root, "shutdown", "while :; do sleep 1; done"));
	assert.equal(controller.stop("shutdown"), true);
	const result = await controller.completion;
	assert.equal(result.status, "stopped");
	assert.equal(result.terminationReason, "session_shutdown");
	assert.equal(result.stopReason, "shutdown");
});

test("human log text saying unavailable remains backward-compatible and does not invent remote semantics", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(
		root,
		"legacy-unavailable",
		"while :; do printf 'unavailable\\n'; sleep 0.02; done",
	));
	await sleep(120);
	assert.equal(controller.snapshot().status, "running", "without opt-in policy only process lifecycle and wall timeout are authoritative");
	assert.equal(controller.stop("user"), true);
	assert.equal((await controller.completion).terminationReason, "explicit_stop");
});

test("structured unavailable reports fail closed while the monitor stays alive and the wall clock is frozen", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(
		root,
		"health-unavailable",
		`while :; do printf '%s\\n' '{"version":1,"health":"unavailable"}' >&3; sleep 0.02; done`,
		{
			healthPolicy: { startupGraceMs: 1_500, heartbeatTimeoutMs: 300, unavailableTimeoutMs: 120 },
			terminateGraceMs: 80,
			now: () => 1_000_000,
		},
	));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "health_policy_failed");
	assert.equal(result.healthFailure, "unavailable_timeout");
	assert.match(result.error, /remained unavailable/);
	assert.ok(result.lastHeartbeatAt >= result.startedAt);
});

test("transient health loss followed by structured progress recovery can complete normally", async (t) => {
	const root = workspace(t);
	const command = [
		`printf '%s\\n' '{"version":1,"health":"unavailable"}' >&3`,
		"sleep 0.03",
		`printf '%s\\n' '{"version":1,"health":"healthy","progress":"phase-1"}' >&3`,
		"sleep 0.03",
		`printf '%s\\n' '{"version":1,"health":"healthy","progress":"phase-2"}' >&3`,
	].join("; ");
	const controller = await startManagedBackgroundRun(options(root, "health-recovery", command, {
		healthPolicy: {
			startupGraceMs: 1_500,
			heartbeatTimeoutMs: 300,
			unavailableTimeoutMs: 150,
			staleProgressTimeoutMs: 150,
		},
	}));
	const result = await controller.completion;
	assert.equal(result.status, "completed");
	assert.equal(result.terminationReason, "completed");
	assert.equal(result.healthStatus, "healthy");
	assert.equal(result.healthFailure, undefined);
	assert.ok(result.lastProgressAt >= result.startedAt);
});

test("healthy heartbeats cannot mask sustained stale progress", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(
		root,
		"health-stale",
		`while :; do printf '%s\\n' '{"version":1,"health":"healthy","progress":"unchanged"}' >&3; sleep 0.02; done`,
		{
			healthPolicy: {
				startupGraceMs: 1_500,
				heartbeatTimeoutMs: 300,
				unavailableTimeoutMs: 200,
				staleProgressTimeoutMs: 120,
			},
			terminateGraceMs: 80,
		},
	));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "health_policy_failed");
	assert.equal(result.healthFailure, "stale_progress");
	assert.match(result.error, /progress token did not change/);
});

test("console logs are capped while the latest output tail remains bounded", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(
		root,
		"bounded",
		"i=0; while [ $i -lt 400 ]; do printf 'line-%03d-xxxxxxxx\\n' $i; i=$((i+1)); done",
		{ maxLogBytes: 128, maxTailBytes: 96 },
	));
	const result = await controller.completion;
	assert.equal(result.status, "completed");
	assert.equal(result.logTruncated, true);
	assert.ok(statSync(result.stdoutPath).size <= 128);
	assert.ok(Buffer.byteLength(result.stdoutTail, "utf8") <= 96);
	assert.match(result.stdoutTail, /line-399/);
});
