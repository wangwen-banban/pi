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
		"trap '' TERM; while :; do sleep 1; done",
		{ timeoutMs: 60, terminateGraceMs: 60 },
	));
	const result = await controller.completion;
	assert.equal(result.status, "failed");
	assert.equal(result.terminationReason, "timed_out");
	assert.equal(result.timeoutEscalated, true);
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
