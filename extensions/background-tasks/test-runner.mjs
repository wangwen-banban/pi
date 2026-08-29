import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { TERMINAL_RUN_MANIFEST_FILE } from "./run-persistence.ts";
import { startManagedBackgroundRun } from "./runner.ts";

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-background-run-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(predicate, message, timeoutMs = 2_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await sleep(5);
	}
	assert.fail(message);
}

function options(root, id, command, overrides = {}) {
	return {
		id,
		taskId: `task-${id}`,
		name: id,
		command,
		cwd: root,
		runsDir: join(root, "runs"),
		sessionId: "session-test",
		timeoutMs: 2_000,
		terminateGraceMs: 100,
		killConfirmMs: 100,
		maxTailBytes: 256,
		shell: "/bin/sh",
		...overrides,
	};
}

function runDir(root, id) {
	return join(root, "runs", "session-test", id);
}

function allPaths(root) {
	const paths = [];
	const walk = (directory) => {
		for (const name of readdirSync(directory, { withFileTypes: true })) {
			const target = join(directory, name.name);
			paths.push(target);
			if (name.isDirectory()) walk(target);
		}
	};
	walk(root);
	return paths;
}

class FakeChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdio = [null, this.stdout, this.stderr];
	pid = 424242;
	kill() { return true; }
}

test("durable files contain only a private minimal terminal manifest", async (t) => {
	const root = workspace(t);
	const secretCommand = "printf 'private-output\\n'; printf 'private-error\\n' >&2";
	const secretCwd = join(root, "private-cwd-component");
	mkdirSync(secretCwd, { mode: 0o700 });
	const controller = await startManagedBackgroundRun({
		...options(root, "success", secretCommand),
		cwd: secretCwd,
	});
	const result = await controller.completion;
	assert.equal(result.status, "completed");
	assert.match(result.stdoutTail, /private-output/);
	assert.match(result.stderrTail, /private-error/);
	const directory = runDir(root, "success");
	assert.deepEqual(readdirSync(directory), [TERMINAL_RUN_MANIFEST_FILE]);
	assert.equal(statSync(join(root, "runs")).mode & 0o777, 0o700);
	assert.equal(statSync(join(root, "runs", "session-test")).mode & 0o777, 0o700);
	assert.equal(statSync(directory).mode & 0o777, 0o700);
	assert.equal(statSync(join(directory, TERMINAL_RUN_MANIFEST_FILE)).mode & 0o777, 0o600);
	const durable = allPaths(join(root, "runs"))
		.map((target) => statSync(target).isFile() ? `${target}\n${readFileSync(target, "utf8")}` : target)
		.join("\n");
	for (const forbidden of [secretCommand, "private-output", "private-error", secretCwd, String(process.pid), "stdout.log", "stderr.log"]) {
		assert.equal(durable.includes(forbidden), false, `durable storage leaked forbidden value: ${forbidden}`);
	}
	const manifest = JSON.parse(readFileSync(join(directory, TERMINAL_RUN_MANIFEST_FILE), "utf8"));
	assert.deepEqual(Object.keys(manifest).sort(), [
		"createdAt", "exitCode", "finishedAt", "runId", "sessionId", "startedAt", "status", "taskId", "terminationReason", "timeoutAt", "version",
	].sort());
});

test("non-zero exit and stderr are classified in memory without a stderr log", async (t) => {
	const root = workspace(t);
	const result = await (await startManagedBackgroundRun(options(root, "nonzero", "printf 'bad\\n' >&2; exit 7"))).completion;
	assert.equal(result.status, "failed");
	assert.equal(result.exitCode, 7);
	assert.equal(result.terminationReason, "exit_nonzero");
	assert.match(result.stderrTail, /bad/);
	assert.deepEqual(readdirSync(runDir(root, "nonzero")), [TERMINAL_RUN_MANIFEST_FILE]);
});

test("external signal is a failure", async (t) => {
	const root = workspace(t);
	const result = await (await startManagedBackgroundRun(options(root, "signal", "kill -TERM $$"))).completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "signal");
	assert.equal(result.signal, "SIGTERM");
});

test("timeout sends TERM then KILL but does not finalize until close", async (t) => {
	const root = workspace(t);
	const child = new FakeChild();
	const signals = [];
	const controller = await startManagedBackgroundRun(options(root, "wait-close", "ignored", {
		timeoutMs: 20,
		terminateGraceMs: 20,
		killConfirmMs: 300,
		spawnProcess: () => child,
		signalProcess: (_owned, signal) => { signals.push(signal); return true; },
	}));
	let settled = false;
	controller.completion.then(() => { settled = true; });
	await waitFor(() => signals.includes("SIGKILL"), "SIGKILL was not attempted");
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(settled, false, "SIGKILL send must not fabricate a terminal state");
	child.emit("close", null, "SIGKILL");
	const result = await controller.completion;
	assert.equal(result.terminationReason, "timed_out");
	assert.equal(result.terminationEscalated, true);
	assert.equal(result.signal, "SIGKILL");
});

test("failed TERM/KILL delivery with no close becomes termination_unconfirmed", async (t) => {
	const root = workspace(t);
	const child = new FakeChild();
	const signals = [];
	const controller = await startManagedBackgroundRun(options(root, "unconfirmed", "ignored", {
		timeoutMs: 5_000,
		terminateGraceMs: 15,
		killConfirmMs: 25,
		spawnProcess: () => child,
		signalProcess: (_owned, signal) => { signals.push(signal); return false; },
	}));
	assert.equal(controller.stop("user"), true);
	const result = await controller.completion;
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "termination_unconfirmed");
	assert.equal(result.signalDeliveryFailed, true);
	assert.notEqual(result.terminationReason, "explicit_stop");
	child.emit("close", 0, null);
	assert.equal((await controller.completion).terminationReason, "termination_unconfirmed");
});

test("throwing signal implementation is recorded and never fakes stopped", async (t) => {
	const root = workspace(t);
	const child = new FakeChild();
	const controller = await startManagedBackgroundRun(options(root, "signal-throws", "ignored", {
		timeoutMs: 5_000,
		terminateGraceMs: 10,
		killConfirmMs: 20,
		spawnProcess: () => child,
		signalProcess: () => { throw new Error("do not persist this detail"); },
	}));
	controller.stop("user");
	const result = await controller.completion;
	assert.equal(result.terminationReason, "termination_unconfirmed");
	assert.equal(result.signalDeliveryFailed, true);
	const persisted = readFileSync(join(runDir(root, "signal-throws"), TERMINAL_RUN_MANIFEST_FILE), "utf8");
	assert.equal(persisted.includes("do not persist this detail"), false);
	assert.equal(JSON.parse(persisted).signalDeliveryFailed, true);
});

test("explicit and shutdown stops are classified only after real close", async (t) => {
	for (const [id, reason, expected] of [
		["stop", "user", "explicit_stop"],
		["shutdown", "shutdown", "session_shutdown"],
	]) {
		const root = workspace(t);
		const controller = await startManagedBackgroundRun(options(root, id, "while :; do sleep 1; done"));
		assert.equal(controller.stop(reason), true);
		assert.equal(controller.stop(reason), false);
		const result = await controller.completion;
		assert.equal(result.status, "stopped");
		assert.equal(result.terminationReason, expected);
		assert.equal(result.stopReason, reason);
	}
});

test("human output saying unavailable has no inferred remote semantics", async (t) => {
	const root = workspace(t);
	const controller = await startManagedBackgroundRun(options(root, "legacy-unavailable", "while :; do printf 'unavailable\\n'; sleep 0.02; done"));
	await sleep(120);
	assert.equal(controller.snapshot().status, "running");
	controller.stop("user");
	assert.equal((await controller.completion).terminationReason, "explicit_stop");
});

test("structured unavailable reports fail closed with a monotonic deadline", async (t) => {
	const root = workspace(t);
	const frozenEpoch = Date.now();
	const controller = await startManagedBackgroundRun(options(
		root,
		"health-unavailable",
		`while :; do printf '%s\\n' '{"version":1,"health":"unavailable"}' >&3; sleep 0.02; done`,
		{
			healthPolicy: { startupGraceMs: 1_500, heartbeatTimeoutMs: 300, unavailableTimeoutMs: 120 },
			terminateGraceMs: 80,
			now: () => frozenEpoch,
		},
	));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "health_policy_failed");
	assert.equal(result.healthFailure, "unavailable_timeout");
});

test("transient health loss and changed progress can complete normally", async (t) => {
	const root = workspace(t);
	const command = [
		`printf '%s\\n' '{"version":1,"health":"unavailable"}' >&3`,
		"sleep 0.03",
		`printf '%s\\n' '{"version":1,"health":"healthy","progress":"phase-1"}' >&3`,
		"sleep 0.03",
		`printf '%s\\n' '{"version":1,"health":"healthy","progress":"phase-2"}' >&3`,
	].join("; ");
	const result = await (await startManagedBackgroundRun(options(root, "health-recovery", command, {
		healthPolicy: { startupGraceMs: 1_500, heartbeatTimeoutMs: 300, unavailableTimeoutMs: 150, staleProgressTimeoutMs: 150 },
	}))).completion;
	assert.equal(result.terminationReason, "completed");
	assert.equal(result.healthStatus, "healthy");
	assert.ok(result.lastProgressAt >= result.startedAt);
});

test("healthy heartbeats cannot mask sustained stale progress", async (t) => {
	const root = workspace(t);
	const result = await (await startManagedBackgroundRun(options(
		root,
		"health-stale",
		`while :; do printf '%s\\n' '{"version":1,"health":"healthy","progress":"unchanged"}' >&3; sleep 0.02; done`,
		{
			healthPolicy: { startupGraceMs: 1_500, heartbeatTimeoutMs: 300, unavailableTimeoutMs: 200, staleProgressTimeoutMs: 120 },
			terminateGraceMs: 80,
		},
	))).completion;
	assert.equal(result.terminationReason, "health_policy_failed");
	assert.equal(result.healthFailure, "stale_progress");
});

test("only the bounded latest output tail is retained in memory", async (t) => {
	const root = workspace(t);
	const result = await (await startManagedBackgroundRun(options(
		root,
		"bounded",
		"i=0; while [ $i -lt 400 ]; do printf 'line-%03d-xxxxxxxx\\n' $i; i=$((i+1)); done",
		{ maxTailBytes: 96 },
	))).completion;
	assert.equal(result.logTruncated, true);
	assert.ok(Buffer.byteLength(result.stdoutTail, "utf8") <= 96);
	assert.match(result.stdoutTail, /line-399/);
	assert.deepEqual(readdirSync(runDir(root, "bounded")), [TERMINAL_RUN_MANIFEST_FILE]);
});

test("bad existing storage mode fails closed before spawning", async (t) => {
	const root = workspace(t);
	const runs = join(root, "runs");
	mkdirSync(runs, { mode: 0o700 });
	chmodSync(runs, 0o755);
	let spawned = false;
	await assert.rejects(
		startManagedBackgroundRun(options(root, "bad-mode", "ignored", {
			spawnProcess: () => { spawned = true; return new FakeChild(); },
		})),
		/unsafe|private|created/i,
	);
	assert.equal(spawned, false);
});
