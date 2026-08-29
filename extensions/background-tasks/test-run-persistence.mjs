import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	BACKGROUND_RUN_RECORD_VERSION,
	MAX_TERMINAL_MANIFEST_AGE_MS,
	TERMINAL_RUN_MANIFEST_FILE,
	parseTerminalRunManifest,
	prepareSecureRunDirectory,
	readTerminalRunManifest,
	writeTerminalRunManifest,
} from "./run-persistence.ts";

function workspace(t) {
	const root = mkdtempSync(join(tmpdir(), "pi-run-persistence-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	return root;
}

function manifest(now = Date.now(), overrides = {}) {
	return {
		version: BACKGROUND_RUN_RECORD_VERSION,
		sessionId: "session-one",
		runId: "bg-one",
		taskId: "task-one",
		status: "failed",
		createdAt: now - 100,
		startedAt: now - 100,
		finishedAt: now - 10,
		timeoutAt: now + 1_000,
		terminationReason: "exit_nonzero",
		exitCode: 2,
		...overrides,
	};
}

function parse(value, now = Date.now()) {
	return parseTerminalRunManifest(value, {
		sessionId: "session-one",
		runId: "bg-one",
		taskId: "task-one",
		now,
	});
}

test("strict v3 schema rejects legacy, unknown, mismatched, stale and incoherent records", () => {
	const now = Date.now();
	assert.equal(parse(manifest(now), now).ok, true);
	for (const value of [
		{ ...manifest(now), version: 2 },
		{ ...manifest(now), cwd: "/private/path" },
		{ ...manifest(now), sessionId: "session-two" },
		{ ...manifest(now), runId: "bg-two" },
		{ ...manifest(now), taskId: "task-two" },
		{ ...manifest(now), createdAt: now, startedAt: now - 1 },
		{ ...manifest(now), startedAt: now, finishedAt: now - 1 },
		{ ...manifest(now), timeoutAt: now - 101 },
		{ ...manifest(now), createdAt: now - 20 * 60_000 },
		{ ...manifest(now), startedAt: now - 8 * 24 * 60 * 60 * 1000 },
		{ ...manifest(now), status: "completed", terminationReason: "completed", exitCode: 2 },
		{ ...manifest(now), status: "stopped", terminationReason: "explicit_stop", stopReason: "shutdown" },
		{ ...manifest(now), terminationReason: "signal", signal: undefined },
		{ ...manifest(now), terminationReason: "termination_unconfirmed", stopReason: "user" },
		{ ...manifest(now), terminationReason: "health_policy_failed", stopReason: "health_policy" },
		{ ...manifest(now), healthStatus: "healthy", unavailableSince: now - 20 },
		{ ...manifest(now), healthDeadlineAt: now - 101 },
		{ ...manifest(now), lastHeartbeatAt: now + 1 },
	]) {
		assert.equal(parse(value, now).ok, false);
	}
	const stale = manifest(now, {
		createdAt: now - MAX_TERMINAL_MANIFEST_AGE_MS - 200,
		startedAt: now - MAX_TERMINAL_MANIFEST_AGE_MS - 200,
		finishedAt: now - MAX_TERMINAL_MANIFEST_AGE_MS - 1,
		timeoutAt: now - MAX_TERMINAL_MANIFEST_AGE_MS + 800,
	});
	assert.deepEqual(parse(stale, now), { ok: false, code: "stale" });
	assert.deepEqual(parse({ ...manifest(now), finishedAt: now + 10 * 60_000 }, now), { ok: false, code: "stale" });
});

test("terminal classification coherence matrix is strict and fail-closed", () => {
	const now = Date.now();
	const classified = (overrides) => manifest(now, { exitCode: undefined, ...overrides });
	const accepted = [
		["completed", classified({ status: "completed", terminationReason: "completed", exitCode: 0 })],
		["exit_nonzero", classified({ terminationReason: "exit_nonzero", exitCode: 7 })],
		["signal", classified({ terminationReason: "signal", signal: "SIGTERM" })],
		["spawn_error", classified({ terminationReason: "spawn_error", exitCode: 1, healthStatus: "awaiting" })],
		["timed_out", classified({ terminationReason: "timed_out", stopReason: "timeout", signal: "SIGKILL", terminationEscalated: true })],
		["health_policy_failed", classified({
			terminationReason: "health_policy_failed",
			stopReason: "health_policy",
			healthStatus: "healthy",
			healthFailure: "stale_progress",
			lastHeartbeatAt: now - 30,
			lastProgressAt: now - 40,
			signal: "SIGTERM",
		})],
		["monitor_restarted", classified({ terminationReason: "monitor_restarted" })],
		["recovery_blocked", classified({ terminationReason: "recovery_blocked" })],
		["persistence_failed", classified({ terminationReason: "persistence_failed" })],
		["termination_unconfirmed", classified({
			terminationReason: "termination_unconfirmed",
			stopReason: "user",
			terminationEscalated: true,
			signalDeliveryFailed: true,
		})],
		["explicit_stop", classified({ status: "stopped", terminationReason: "explicit_stop", stopReason: "user", signal: "SIGTERM" })],
		["session_shutdown", classified({ status: "stopped", terminationReason: "session_shutdown", stopReason: "shutdown", exitCode: 0 })],
	];
	for (const [name, value] of accepted) {
		assert.equal(parse(value, now).ok, true, `${name} should be coherent`);
	}

	const rejected = [
		["QA completed escalation contradiction", classified({
			status: "completed",
			terminationReason: "completed",
			exitCode: 0,
			terminationEscalated: true,
			signalDeliveryFailed: true,
		})],
		["completed with signal", classified({ status: "completed", terminationReason: "completed", exitCode: 0, signal: "SIGTERM" })],
		["completed with timeout stop", classified({ status: "completed", terminationReason: "completed", exitCode: 0, stopReason: "timeout" })],
		["completed with health failure", classified({
			status: "completed",
			terminationReason: "completed",
			exitCode: 0,
			healthStatus: "healthy",
			healthFailure: "heartbeat_timeout",
		})],
		["completed status/reason mismatch", classified({ status: "failed", terminationReason: "completed", exitCode: 0 })],
		["nonzero with zero exit", classified({ terminationReason: "exit_nonzero", exitCode: 0 })],
		["nonzero with signal", classified({ terminationReason: "exit_nonzero", exitCode: 2, signal: "SIGTERM" })],
		["signal without signal", classified({ terminationReason: "signal" })],
		["spawn error with arbitrary exit", classified({ terminationReason: "spawn_error", exitCode: 2 })],
		["timeout without timeout stop", classified({ terminationReason: "timed_out" })],
		["timeout with health failure", classified({
			terminationReason: "timed_out",
			stopReason: "timeout",
			healthStatus: "healthy",
			healthFailure: "heartbeat_timeout",
		})],
		["health failure missing code", classified({ terminationReason: "health_policy_failed", stopReason: "health_policy", healthStatus: "healthy" })],
		["health failure wrong stop", classified({
			terminationReason: "health_policy_failed",
			stopReason: "timeout",
			healthStatus: "healthy",
			healthFailure: "heartbeat_timeout",
		})],
		["monitor restart with exit", classified({ terminationReason: "monitor_restarted", exitCode: 1 })],
		["recovery blocked with stop", classified({ terminationReason: "recovery_blocked", stopReason: "user" })],
		["unconfirmed without escalation", classified({ terminationReason: "termination_unconfirmed", stopReason: "user", signalDeliveryFailed: true })],
		["unconfirmed with observed exit", classified({
			terminationReason: "termination_unconfirmed",
			stopReason: "user",
			exitCode: 1,
			terminationEscalated: true,
			signalDeliveryFailed: true,
		})],
		["unconfirmed without signal evidence", classified({ terminationReason: "termination_unconfirmed", stopReason: "user", terminationEscalated: true })],
		["persistence failure with unbound escalation", classified({ terminationReason: "persistence_failed", terminationEscalated: true })],
		["stopped with health failure", classified({
			status: "stopped",
			terminationReason: "explicit_stop",
			stopReason: "user",
			healthStatus: "healthy",
			healthFailure: "heartbeat_timeout",
		})],
		["unavailable status without since", classified({ terminationReason: "exit_nonzero", exitCode: 2, healthStatus: "unavailable" })],
		["health metadata without status", classified({ terminationReason: "exit_nonzero", exitCode: 2, lastHeartbeatAt: now - 20 })],
		["legacy timedOut flag", { ...classified({ terminationReason: "timed_out", stopReason: "timeout" }), timedOut: true }],
		["legacy timeoutEscalated flag", { ...classified({ terminationReason: "timed_out", stopReason: "timeout" }), timeoutEscalated: true }],
	];
	for (const [name, value] of rejected) {
		assert.deepEqual(parse(value, now), { ok: false, code: "invalid_schema" }, `${name} must be rejected`);
	}
});

test("safe identities and exclusive directories reject traversal and symlinks", async (t) => {
	const root = workspace(t);
	const runs = join(root, "runs");
	await assert.rejects(prepareSecureRunDirectory(runs, "../session", "bg-one", "task-one"), /invalid session/i);
	await assert.rejects(prepareSecureRunDirectory(runs, "session-one", "../run", "task-one"), /invalid run/i);
	await assert.rejects(prepareSecureRunDirectory(runs, "session-one", "bg-one", "../task"), /invalid task/i);

	mkdirSync(runs, { mode: 0o700 });
	const outside = join(root, "outside");
	mkdirSync(outside, { mode: 0o700 });
	const linkedRoot = join(root, "runs-link");
	symlinkSync(outside, linkedRoot);
	await assert.rejects(prepareSecureRunDirectory(linkedRoot, "session-one", "bg-one", "task-one"), /unsafe/i);
	symlinkSync(outside, join(runs, "session-link"));
	await assert.rejects(prepareSecureRunDirectory(runs, "session-link", "bg-one", "task-one"), /unsafe/i);

	const session = join(runs, "session-one");
	mkdirSync(session, { mode: 0o700 });
	symlinkSync(outside, join(session, "bg-link"));
	await assert.rejects(prepareSecureRunDirectory(runs, "session-one", "bg-link", "task-one"), /already exists|created/i);
});

test("manifest reader rejects symlink, bad mode and session binding mismatch", async (t) => {
	const root = workspace(t);
	const runs = join(root, "runs");
	const runDir = await prepareSecureRunDirectory(runs, "session-one", "bg-one", "task-one");
	const now = Date.now();
	await writeTerminalRunManifest(runDir, manifest(now));
	let result = await readTerminalRunManifest(runs, {
		sessionId: "session-one",
		runId: "bg-one",
		taskId: "task-one",
		now,
	});
	assert.equal(result.ok, true);
	chmodSync(join(runDir, TERMINAL_RUN_MANIFEST_FILE), 0o644);
	result = await readTerminalRunManifest(runs, {
		sessionId: "session-one",
		runId: "bg-one",
		taskId: "task-one",
		now,
	});
	assert.deepEqual(result, { ok: false, code: "bad_mode" });

	const mismatchDir = await prepareSecureRunDirectory(runs, "session-one", "bg-mismatch", "task-one");
	writeFileSync(
		join(mismatchDir, TERMINAL_RUN_MANIFEST_FILE),
		`${JSON.stringify(manifest(now, { runId: "bg-other" }))}\n`,
		{ mode: 0o600 },
	);
	result = await readTerminalRunManifest(runs, {
		sessionId: "session-one",
		runId: "bg-mismatch",
		taskId: "task-one",
		now,
	});
	assert.deepEqual(result, { ok: false, code: "mismatch" });

	const linkDir = await prepareSecureRunDirectory(runs, "session-one", "bg-symlink", "task-one");
	const target = join(root, "target.json");
	writeFileSync(target, `${JSON.stringify(manifest(now, { runId: "bg-symlink" }))}\n`, { mode: 0o600 });
	symlinkSync(target, join(linkDir, TERMINAL_RUN_MANIFEST_FILE));
	result = await readTerminalRunManifest(runs, {
		sessionId: "session-one",
		runId: "bg-symlink",
		taskId: "task-one",
		now,
	});
	assert.equal(result.ok, false);
	assert.ok(["unsafe_path", "io_error"].includes(result.code));

	const nonFileDir = await prepareSecureRunDirectory(runs, "session-one", "bg-non-file", "task-one");
	mkdirSync(join(nonFileDir, TERMINAL_RUN_MANIFEST_FILE), { mode: 0o700 });
	result = await readTerminalRunManifest(runs, {
		sessionId: "session-one",
		runId: "bg-non-file",
		taskId: "task-one",
		now,
	});
	assert.deepEqual(result, { ok: false, code: "unsafe_path" });
});

test("atomic manifest publication leaves no pid-named or temporary files", async (t) => {
	const root = workspace(t);
	const runs = join(root, "runs");
	const runDir = await prepareSecureRunDirectory(runs, "session-one", "bg-one", "task-one");
	await writeTerminalRunManifest(runDir, manifest());
	const names = readdirSync(runDir);
	assert.deepEqual(names, [TERMINAL_RUN_MANIFEST_FILE]);
	assert.equal(names.join("\n").includes(String(process.pid)), false);
	await assert.rejects(writeTerminalRunManifest(runDir, manifest()), /already exists/i);
});

test("bad directory modes are rejected rather than repaired", async (t) => {
	const root = workspace(t);
	const runs = join(root, "runs");
	mkdirSync(runs, { mode: 0o700 });
	chmodSync(runs, 0o755);
	await assert.rejects(prepareSecureRunDirectory(runs, "session-one", "bg-one", "task-one"), /mode/i);
});
