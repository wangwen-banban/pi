import assert from "node:assert/strict";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildBackgroundRuntimeRecord, buildBackgroundTasksRecord, writeBackgroundWebRecord } from "./web-record.ts";

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
		lastProgressAt: 175,
		lastHeartbeatAt: 190,
		healthStatus: "healthy",
		healthDeadlineAt: 1_500,
		stdoutTail: liveOutput,
		stderrTail: "",
		stdoutPath: "/private/stdout.log",
		stderrPath: "/private/stderr.log",
		resultPath: "/private/result.json",
		logTruncated: false,
		command: secretCommand,
		pid: 12345,
		apiKey: "top-secret",
		healthProgressToken: "private-progress-token",
	};
	const record = buildBackgroundTasksRecord(plan, [run], identity, 300);
	const serialized = JSON.stringify(record);
	assert.equal(serialized.includes(secretTaskText), false);
	assert.equal(serialized.includes(secretCommand), false);
	assert.equal(serialized.includes(liveOutput), false);
	assert.equal(serialized.includes("top-secret"), false);
	assert.equal(serialized.includes("private-progress-token"), false);
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
	assert.equal(record.runs[0].name, "benchmark", "web records use only the stable task id, never a user-provided run name");
	assert.equal(serialized.includes("benchmark_run"), false);
	assert.equal(record.runs[0].lastProgressAt, 175);
	assert.equal(record.runs[0].lastHeartbeatAt, 190);
	assert.equal(record.runs[0].healthStatus, "healthy");
	assert.equal(record.runs[0].healthDeadlineAt, 1_500);
});

test("background web writer creates a private chain and rejects unsafe adoption", async (t) => {
	const worktree = mkdtempSync(join(tmpdir(), "pi-background-web-"));
	t.after(() => rmSync(worktree, { recursive: true, force: true }));
	const root = join(worktree, "registry", "sessions", "runtime-one");
	const record = { schemaVersion: 1, source: "background-tasks", sessionId: "session-1" };
	assert.equal(await writeBackgroundWebRecord(root, worktree, "runtime", record), true, "a normal missing registry chain should be created");
	assert.deepEqual(readdirSync(root), ["runtime.json"]);
	assert.equal(readFileSync(join(root, "runtime.json"), "utf8"), `${JSON.stringify(record)}\n`);
	assert.equal(statSync(root).mode & 0o777, 0o700);
	assert.equal(statSync(join(worktree, "registry")).mode & 0o777, 0o700);
	assert.equal(statSync(join(root, "runtime.json")).mode & 0o777, 0o600);
	chmodSync(join(root, "runtime.json"), 0o644);
	assert.equal(await writeBackgroundWebRecord(root, worktree, "runtime", record), false, "bad file mode must be rejected");
	chmodSync(join(root, "runtime.json"), 0o600);
	chmodSync(root, 0o755);
	assert.equal(await writeBackgroundWebRecord(root, worktree, "runtime", record), false, "bad directory mode must be rejected");
	chmodSync(root, 0o700);

	const outside = mkdtempSync(join(tmpdir(), "pi-background-web-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	chmodSync(outside, 0o700);
	assert.equal(await writeBackgroundWebRecord(outside, worktree, "runtime", record), false, "realpath must stay inside the worktree");
	assert.deepEqual(readdirSync(outside), []);

	rmSync(join(root, "runtime.json"));
	const target = join(worktree, "target.json");
	writeFileSync(target, "unchanged", { mode: 0o600 });
	symlinkSync(target, join(root, "runtime.json"));
	assert.equal(await writeBackgroundWebRecord(root, worktree, "runtime", record), false);
	assert.equal(readFileSync(target, "utf8"), "unchanged");
});

test("background web writer rejects every controlled ancestor symlink before writing", async (t) => {
	const worktree = mkdtempSync(join(tmpdir(), "pi-background-web-links-"));
	t.after(() => rmSync(worktree, { recursive: true, force: true }));
	const outside = mkdtempSync(join(tmpdir(), "pi-background-web-link-outside-"));
	t.after(() => rmSync(outside, { recursive: true, force: true }));
	const record = { schemaVersion: 1, source: "background-tasks", sessionId: "session-1" };

	const insideTarget = join(worktree, "inside-target");
	mkdirSync(insideTarget, { mode: 0o700 });
	const insideParent = join(worktree, "inside-parent");
	mkdirSync(insideParent, { mode: 0o700 });
	symlinkSync(insideTarget, join(insideParent, "linked-ancestor"));
	assert.equal(
		await writeBackgroundWebRecord(join(insideParent, "linked-ancestor", "registry"), worktree, "runtime", record),
		false,
		"an ancestor link that stays inside the worktree is still attacker-controlled",
	);
	assert.deepEqual(readdirSync(insideTarget), [], "inside symlink target must remain untouched");

	const outsideParent = join(worktree, "outside-parent");
	mkdirSync(outsideParent, { mode: 0o700 });
	symlinkSync(outside, join(outsideParent, "linked-ancestor"));
	assert.equal(
		await writeBackgroundWebRecord(join(outsideParent, "linked-ancestor", "registry"), worktree, "runtime", record),
		false,
		"an ancestor link escaping the worktree must be rejected",
	);
	assert.deepEqual(readdirSync(outside), [], "outside symlink target must remain untouched");

	const nonDirectoryParent = join(worktree, "non-directory-parent");
	mkdirSync(nonDirectoryParent, { mode: 0o700 });
	const nonDirectory = join(nonDirectoryParent, "registry-base");
	writeFileSync(nonDirectory, "unchanged", { mode: 0o600 });
	assert.equal(
		await writeBackgroundWebRecord(join(nonDirectory, "runtime"), worktree, "runtime", record),
		false,
		"an existing non-directory ancestor must be rejected",
	);
	assert.equal(readFileSync(nonDirectory, "utf8"), "unchanged");
});

test("runtime heartbeat identifies background source and shutdown omits heartbeat", () => {
	const active = buildBackgroundRuntimeRecord(identity, "active", { startedAt: 10, total: 3, active: 1 }, 20);
	assert.equal(active.source, "background-tasks");
	assert.equal(active.heartbeatAt, 20);
	assert.deepEqual(active.jobs, { total: 3, active: 1 });
	const shutdown = buildBackgroundRuntimeRecord(identity, "shutdown", { startedAt: 10, total: 3, active: 0 }, 30);
	assert.equal(Object.hasOwn(shutdown, "heartbeatAt"), false);
});
