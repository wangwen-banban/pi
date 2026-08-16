import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	applyFinalOutcome,
	classifyChildClose,
	createActivityRefreshLoop,
	createExecutionTimeout,
	shutdownJobs,
	writeJsonAtomically,
} from "./lifecycle.ts";

class FakeTimers {
	now = 0;
	nextId = 1;
	tasks = new Map();

	setTimeout(callback, delayMs) {
		const id = this.nextId++;
		this.tasks.set(id, { callback, due: this.now + delayMs });
		return id;
	}

	clearTimeout(id) {
		this.tasks.delete(id);
	}

	advance(delayMs) {
		const target = this.now + delayMs;
		while (true) {
			const due = [...this.tasks.entries()]
				.filter(([, task]) => task.due <= target)
				.sort((left, right) => left[1].due - right[1].due || left[0] - right[0])[0];
			if (!due) break;
			const [id, task] = due;
			this.tasks.delete(id);
			this.now = task.due;
			task.callback();
		}
		this.now = target;
	}

	get pending() {
		return this.tasks.size;
	}
}

const closeDefaults = {
	hardTimeoutMs: 30 * 60_000,
	terminateGraceMs: 5_000,
};

test("duration refresh starts for active work, ticks, and stops with no active jobs", () => {
	const timers = new FakeTimers();
	let status = "completed";
	let ticks = 0;
	const loop = createActivityRefreshLoop({
		hasActiveJobs: () => status === "queued" || status === "running",
		onTick: () => ticks++,
		intervalMs: 1000,
		timers,
	});

	loop.sync();
	assert.equal(loop.running, false);
	status = "queued";
	loop.sync();
	assert.equal(loop.running, true);
	assert.equal(timers.pending, 1);
	timers.advance(1000);
	assert.equal(ticks, 1);
	assert.equal(timers.pending, 1);
	status = "completed";
	loop.sync();
	assert.equal(loop.running, false);
	assert.equal(timers.pending, 0);
	status = "running";
	loop.sync();
	loop.stop();
	assert.equal(timers.pending, 0);
});

test("normal exit zero is completed", () => {
	assert.deepEqual(classifyChildClose({ ...closeDefaults, code: 0, signal: null }), {
		status: "completed",
		exitCode: 0,
		terminationReason: "completed",
	});
});

test("nonzero exit is failed with the child error", () => {
	const outcome = classifyChildClose({
		...closeDefaults,
		code: 23,
		signal: null,
		stderr: "provider failed",
	});
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.exitCode, 23);
	assert.equal(outcome.terminationReason, "exit_nonzero");
	assert.equal(outcome.error, "provider failed");
});

test("signal close with null code is an actionable failure, never completed", () => {
	const outcome = classifyChildClose({ ...closeDefaults, code: null, signal: "SIGTERM" });
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.exitCode, 143);
	assert.equal(outcome.signal, "SIGTERM");
	assert.equal(outcome.terminationReason, "signal");
	assert.match(outcome.error, /external signal SIGTERM/);
});

test("explicit stop and shutdown are classified separately", () => {
	const explicit = classifyChildClose({
		...closeDefaults,
		code: null,
		signal: "SIGTERM",
		stopRequest: "user",
	});
	const shutdown = classifyChildClose({
		...closeDefaults,
		code: null,
		signal: "SIGTERM",
		stopRequest: "shutdown",
	});
	assert.equal(explicit.status, "stopped");
	assert.equal(explicit.terminationReason, "explicit_stop");
	assert.match(explicit.error, /\/agents stop/);
	assert.equal(shutdown.status, "stopped");
	assert.equal(shutdown.terminationReason, "session_shutdown");
});

test("hard timeout sends TERM then KILL after grace without waiting real time", () => {
	const timers = new FakeTimers();
	const signals = [];
	let timedOut = 0;
	let escalated = 0;
	const controller = createExecutionTimeout({
		process: {
			kill(signal) {
				signals.push(signal);
				return true;
			},
		},
		timeoutMs: 30_000,
		graceMs: 5_000,
		timers,
		onTimeout: () => timedOut++,
		onEscalate: () => escalated++,
	});

	timers.advance(29_999);
	assert.deepEqual(signals, []);
	timers.advance(1);
	assert.deepEqual(signals, ["SIGTERM"]);
	assert.equal(timedOut, 1);
	assert.equal(controller.timedOut, true);
	timers.advance(4_999);
	assert.deepEqual(signals, ["SIGTERM"]);
	timers.advance(1);
	assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
	assert.equal(escalated, 1);
	assert.equal(controller.escalated, true);
	controller.cancel();
	assert.equal(timers.pending, 0);
});

test("cancelling an execution timeout clears both hard and grace timers", () => {
	const timers = new FakeTimers();
	const signals = [];
	const controller = createExecutionTimeout({
		process: { kill(signal) { signals.push(signal); return true; } },
		timeoutMs: 1000,
		graceMs: 500,
		timers,
		onTimeout() {},
		onEscalate() {},
	});
	controller.cancel();
	timers.advance(5000);
	assert.deepEqual(signals, []);
	assert.equal(timers.pending, 0);
});

test("timeout classification is failed/timed_out and names the actionable config", () => {
	const outcome = classifyChildClose({
		...closeDefaults,
		code: null,
		signal: "SIGKILL",
		timedOut: true,
		timeoutEscalated: true,
	});
	assert.equal(outcome.status, "failed");
	assert.equal(outcome.terminationReason, "timed_out");
	assert.match(outcome.error, /hard execution limit/);
	assert.match(outcome.error, /SIGTERM/);
	assert.match(outcome.error, /SIGKILL/);
	assert.match(outcome.error, /execution\.hardTimeoutMs/);
});

test("shutdown durably stops running, queued, and routing jobs", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "smart-subagents-shutdown-"));
	try {
		const processRef = { kill() { return true; } };
		const jobs = [
			{ id: "running", status: "running", process: processRef, logPath: path.join(directory, "running", "result.json") },
			{ id: "queued", status: "queued", logPath: path.join(directory, "queued", "result.json") },
			{ id: "routing", status: "routing", logPath: path.join(directory, "routing", "result.json") },
			{ id: "done", status: "completed", logPath: path.join(directory, "done", "result.json") },
		];
		const terminated = [];
		const count = await shutdownJobs(jobs, {
			markStopping(job) {
				job.stopRequest = "shutdown";
			},
			async finalize(job) {
				const applied = applyFinalOutcome(job, {
					status: "stopped",
					exitCode: 0,
					terminationReason: "session_shutdown",
					error: "Stopped because the parent session shut down.",
				}, 1234);
				assert.equal(applied, true);
				await writeJsonAtomically(job.logPath, job);
			},
			terminate(process, job) {
				terminated.push([process, job.id]);
			},
		});

		assert.equal(count, 3);
		assert.deepEqual(terminated, [[processRef, "running"]]);
		for (const id of ["running", "queued", "routing"]) {
			const result = JSON.parse(await readFile(path.join(directory, id, "result.json"), "utf8"));
			assert.equal(result.status, "stopped");
			assert.equal(result.terminationReason, "session_shutdown");
		}
		assert.equal(jobs[3].status, "completed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("terminal transition is claimed once across error/close races", () => {
	const job = { status: "running", process: {} };
	const first = applyFinalOutcome(job, {
		status: "failed",
		exitCode: 1,
		terminationReason: "spawn_error",
		error: "spawn failed",
	}, 100);
	const second = applyFinalOutcome(job, {
		status: "completed",
		exitCode: 0,
		terminationReason: "completed",
	}, 200);
	assert.equal(first, true);
	assert.equal(second, false);
	assert.equal(job.status, "failed");
	assert.equal(job.finishedAt, 100);
	assert.equal(job.error, "spawn failed");
});

test("atomic result writer creates a private result.json", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "smart-subagents-result-"));
	const resultPath = path.join(directory, "nested", "result.json");
	try {
		await writeJsonAtomically(resultPath, { status: "stopped", reason: "shutdown" });
		assert.deepEqual(JSON.parse(await readFile(resultPath, "utf8")), {
			status: "stopped",
			reason: "shutdown",
		});
		assert.equal((await stat(resultPath)).mode & 0o777, 0o600);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
