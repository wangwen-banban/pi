import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
	ControlDispatcher,
	WebActivityRegistry,
	buildControlAck,
	parseControlRequest,
	sanitizeRecord,
	WEB_ACTIVITY_EXCLUDE_PATTERN,
	WEB_ACTIVITY_SCHEMA_DIR,
	WEB_ACTIVITY_SCHEMA_VERSION,
} from "./registry.ts";

const identity = { sessionId: "sess-1", runtimeId: "rt-1", generation: 3, controlToken: "tok-abc" };
const webEnv = { PI_WEB_SESSION: "1" };

async function makeCwd() {
	return mkdtemp(path.join(os.tmpdir(), "web-activity-"));
}

/** Simulates "not a git repository". */
function noRepoGit() {
	return async () => ({ code: 128, stdout: "" });
}

/** Simulates a git worktree whose exclude file lives in <worktree>/.git/info/exclude. */
function fakeWorktreeGit(worktree, { checkIgnoreCode = 0 } = {}) {
	const excludePath = path.join(worktree, ".git", "info", "exclude");
	return async (args) => {
		const joined = args.join(" ");
		if (joined.startsWith("rev-parse --show-toplevel")) return { code: 0, stdout: `${worktree}\n` };
		if (joined.startsWith("rev-parse --git-path info/exclude")) return { code: 0, stdout: `${excludePath}\n` };
		if (joined.startsWith("check-ignore")) return { code: checkIgnoreCode, stdout: "" };
		return { code: 1, stdout: "" };
	};
}

function validRequest(overrides = {}) {
	const now = Date.now();
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		controlToken: identity.controlToken,
		requestId: "req-1",
		action: "stop_all",
		createdAt: now - 1000,
		expiresAt: now + 30_000,
		...overrides,
	};
}

test("registry stays disabled without PI_WEB_SESSION", async () => {
	const cwd = await makeCwd();
	try {
		const registry = await WebActivityRegistry.create({ cwd, identity, env: {} });
		assert.equal(registry.enabled, false);
		assert.match(registry.disabledReason, /PI_WEB_SESSION/);
		assert.equal(await registry.write("agents", { a: 1 }), false);
		assert.equal(await registry.ackControl("req-1", { accepted: true }), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("non-git workspace uses ctx.cwd as the registry root", async () => {
	const cwd = await makeCwd();
	try {
		const registry = await WebActivityRegistry.create({ cwd, identity, env: webEnv, runGit: noRepoGit() });
		assert.equal(registry.enabled, true);
		assert.equal(registry.worktreeRoot, cwd);
		assert.equal(
			registry.root,
			path.join(cwd, ".pi", ".runtime", "pi-web-activity", "v1", "sessions", "sess-1", "runtimes", "rt-1"),
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("canonical constants and exact nested runtime paths", async () => {
	assert.equal(WEB_ACTIVITY_SCHEMA_VERSION, 1);
	assert.equal(WEB_ACTIVITY_SCHEMA_DIR, "v1");
	const cwd = await makeCwd();
	try {
		const registry = await WebActivityRegistry.create({ cwd, identity, env: webEnv, runGit: noRepoGit() });
		assert.equal(registry.enabled, true);
		assert.equal(
			registry.root,
			path.join(cwd, ".pi", ".runtime", "pi-web-activity", "v1", "sessions", "sess-1", "runtimes", "rt-1"),
		);
		assert.equal(registry.requestsDir, path.join(registry.root, "requests"));
		assert.equal(registry.acksDir, path.join(registry.root, "acks"));
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("traversal / invalid identity segments disable the registry fail-closed", async () => {
	const cwd = await makeCwd();
	try {
		const badIdentities = [
			{ sessionId: "../evil", runtimeId: "rt-1" },
			{ sessionId: "sess-1", runtimeId: "a/b" },
			{ sessionId: "", runtimeId: "rt-1" },
			{ sessionId: "sess-1", runtimeId: "a".repeat(200) },
			{ sessionId: "-lead", runtimeId: "rt-1" },
			{ sessionId: "sess-1", runtimeId: "rt one" },
			{ sessionId: "sess-1", runtimeId: "rt\\evil" },
		];
		for (const bad of badIdentities) {
			const notes = [];
			const registry = await WebActivityRegistry.create({
				cwd,
				identity: { ...identity, ...bad },
				env: webEnv,
				runGit: noRepoGit(),
				notify: (message) => notes.push(message),
			});
			assert.equal(registry.enabled, false, JSON.stringify(bad));
			assert.match(registry.disabledReason, /invalid sessionId or runtimeId/);
			assert.equal(await registry.write("runtime", { x: 1 }), false);
			assert.equal(await registry.ackControl("req-1", { accepted: true }), false);
			assert.equal(notes.length, 1);
		}
		// Nothing under sessions/ was created by any invalid identity.
		const sessionsDir = path.join(cwd, ".pi", ".runtime", "pi-web-activity", "v1", "sessions");
		assert.equal(await stat(sessionsDir).then(() => true).catch(() => false), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("writes are sanitized, atomic, private, and serialized", async () => {
	const cwd = await makeCwd();
	try {
		const registry = await WebActivityRegistry.create({ cwd, identity, env: webEnv, runGit: noRepoGit() });
		const ok = await registry.write("agents", {
			sessionId: "sess-1",
			apiKey: "SECRET",
			auth_token: "SECRET2",
			password: "SECRET3",
			keep: "value",
			big: "x".repeat(5000),
			deep: { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } },
			nan: Number.NaN,
			huge: 1e30,
		});
		assert.equal(ok, true);
		const filePath = path.join(registry.root, "agents.json");
		const parsed = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(parsed.apiKey, undefined);
		assert.equal(parsed.auth_token, undefined);
		assert.equal(parsed.password, undefined);
		assert.equal(parsed.keep, "value");
		assert.equal(parsed.big.length, 513); // 512 chars + ellipsis
		assert.equal(parsed.nan, null);
		assert.equal(parsed.huge, 1e15);
		assert.equal(parsed.deep.a.b.c.d.e, null); // beyond maxDepth → dropped
		assert.equal((await stat(filePath)).mode & 0o777, 0o600);
		assert.equal((await stat(registry.root)).mode & 0o777, 0o700);

		// Concurrent writes must never leave a torn file; the last one wins.
		const writes = [];
		for (let i = 0; i < 20; i++) writes.push(registry.write("agents", { n: i, tag: `w${i}` }));
		await Promise.all(writes);
		const final = JSON.parse(await readFile(filePath, "utf8"));
		assert.equal(typeof final.n, "number");
		assert.match(final.tag, /^w\d+$/);
		// No temp files left behind.
		const leftovers = (await readdir(registry.root)).filter((name) => name.includes(".tmp"));
		assert.deepEqual(leftovers, []);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("oversized records are refused and reported once", async () => {
	const cwd = await makeCwd();
	try {
		const notes = [];
		const registry = await WebActivityRegistry.create({
			cwd,
			identity,
			env: webEnv,
			runGit: noRepoGit(),
			notify: (message) => notes.push(message),
		});
		// A record of many distinct long strings exceeds the byte cap.
		const big = { rows: Array.from({ length: 500 }, (_, i) => `row-${i}-${"y".repeat(500)}`) };
		assert.equal(await registry.write("agents", big), false);
		assert.equal(await registry.write("agents", big), false);
		assert.equal(notes.length, 1);
		assert.match(notes[0], /exceeds/);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("write I/O failures resolve false, warn once, and never reject", async () => {
	const cwd = await makeCwd();
	try {
		const notes = [];
		const registry = await WebActivityRegistry.create({
			cwd,
			identity,
			env: webEnv,
			runGit: noRepoGit(),
			notify: (message) => notes.push(message),
		});
		// Replace the runtime directory with a regular file so every write fails.
		await rm(registry.root, { recursive: true, force: true });
		await writeFile(registry.root, "not a directory", "utf8");

		// Each call resolves (never rejects) to false and warns exactly once.
		assert.equal(await registry.write("runtime", { hello: "world" }), false);
		assert.equal(await registry.write("runtime", { hello: "world" }), false);
		assert.equal(notes.length, 1);
		assert.match(notes[0], /write for "runtime" failed/);

		// Control acks are non-rejecting too.
		assert.equal(await registry.ackControl("req-1", { accepted: true }), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("git worktree registers the exclude pattern before writing", async () => {
	const cwd = await makeCwd();
	const worktree = path.join(cwd, "repo");
	await mkdir(path.join(worktree, ".git", "info"), { recursive: true });
	try {
		const registry = await WebActivityRegistry.create({
			cwd: worktree,
			identity,
			env: webEnv,
			runGit: fakeWorktreeGit(worktree),
		});
		assert.equal(registry.enabled, true);
		assert.equal(registry.worktreeRoot, worktree);
		const exclude = await readFile(path.join(worktree, ".git", "info", "exclude"), "utf8");
		assert.ok(exclude.split(/\r?\n/).includes(WEB_ACTIVITY_EXCLUDE_PATTERN));
		await registry.write("runtime", { hello: "world" });
		const parsed = JSON.parse(await readFile(path.join(registry.root, "runtime.json"), "utf8"));
		assert.equal(parsed.hello, "world");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("registry disables itself and notifies when git exclusion cannot be guaranteed", async () => {
	const cwd = await makeCwd();
	const worktree = path.join(cwd, "repo");
	await mkdir(path.join(worktree, ".git", "info"), { recursive: true });
	try {
		const notes = [];
		const registry = await WebActivityRegistry.create({
			cwd: worktree,
			identity,
			env: webEnv,
			runGit: fakeWorktreeGit(worktree, { checkIgnoreCode: 1 }),
			notify: (message) => notes.push(message),
		});
		assert.equal(registry.enabled, false);
		assert.match(registry.disabledReason, /check-ignore/);
		assert.equal(notes.length, 1);
		assert.match(notes[0], /check-ignore/);
		assert.equal(await registry.write("runtime", { hello: "world" }), false);
		assert.equal(
			await stat(
				path.join(worktree, ".pi", ".runtime", "pi-web-activity", "v1", "sessions", "sess-1", "runtimes", "rt-1", "runtime.json"),
			)
				.then(() => true)
				.catch(() => false),
			false,
		);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("registry disables itself when the exclude file cannot be written", async () => {
	const cwd = await makeCwd();
	const worktree = path.join(cwd, "repo");
	// Block .git/info creation with a regular file at that path.
	await mkdir(path.join(worktree, ".git"), { recursive: true });
	await writeFile(path.join(worktree, ".git", "info"), "not a directory", "utf8");
	try {
		const notes = [];
		const registry = await WebActivityRegistry.create({
			cwd: worktree,
			identity,
			env: webEnv,
			runGit: fakeWorktreeGit(worktree),
			notify: (message) => notes.push(message),
		});
		assert.equal(registry.enabled, false);
		assert.match(registry.disabledReason, /exclude|info/);
		assert.ok(notes.length >= 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("git unavailable inside a repository fails closed", async () => {
	const cwd = await makeCwd();
	const worktree = path.join(cwd, "repo");
	await mkdir(path.join(worktree, ".git"), { recursive: true });
	try {
		const notes = [];
		const registry = await WebActivityRegistry.create({
			cwd: worktree,
			identity,
			env: webEnv,
			runGit: async () => ({ code: null, stdout: "" }), // ENOENT-like
			notify: (message) => notes.push(message),
		});
		assert.equal(registry.enabled, false);
		assert.match(registry.disabledReason, /git is unavailable/);
		assert.ok(notes.length >= 1);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("parseControlRequest accepts a well-formed request", () => {
	const result = parseControlRequest(validRequest(), identity);
	assert.equal(result.ok, true);
	assert.deepEqual(result.request.action, "stop_all");
});

test("parseControlRequest rejects schema, identity, generation, token, action and id mismatches", () => {
	const cases = [
		[{ schemaVersion: "v2" }, /schemaVersion/],
		[{ schemaVersion: "1" }, /schemaVersion/],
		[{ sessionId: "sess-OTHER" }, /sessionId/],
		[{ runtimeId: "rt-OTHER" }, /runtimeId/],
		[{ generation: identity.generation - 1 }, /generation/],
		[{ controlToken: "wrong-token" }, /controlToken/],
		[{ action: "rm -rf" }, /unsupported action/],
		[{ action: "stop_one" }, /jobId/],
		[{ action: "stop_one", jobId: "" }, /jobId/],
		[{ requestId: "bad/id!" }, /requestId/],
		[{ requestId: "" }, /requestId/],
	];
	for (const [overrides, expected] of cases) {
		const result = parseControlRequest(validRequest(overrides), identity);
		assert.equal(result.ok, false, JSON.stringify(overrides));
		assert.match(result.reason, expected);
	}
	assert.equal(parseControlRequest(null, identity).ok, false);
	assert.equal(parseControlRequest([1, 2], identity).ok, false);
});

test("parseControlRequest enforces the TTL window and clock-skew bounds", () => {
	const now = Date.now();
	const expired = parseControlRequest(validRequest({ expiresAt: now - 1 }), identity, { now });
	assert.equal(expired.ok, false);
	assert.match(expired.reason, /expired/);
	const futureCreated = parseControlRequest(validRequest({ createdAt: now + 10_000 }), identity, { now });
	assert.equal(futureCreated.ok, false);
	assert.match(futureCreated.reason, /future/);
	const staleCreated = parseControlRequest(validRequest({ createdAt: now - 90_000 }), identity, { now });
	assert.equal(staleCreated.ok, false);
	assert.match(staleCreated.reason, /stale/);
	const longTtl = parseControlRequest(validRequest({ expiresAt: now + 120_000 }), identity, { now });
	assert.equal(longTtl.ok, false);
	assert.match(longTtl.reason, /TTL/);
	const backwards = parseControlRequest(validRequest({ createdAt: now + 5_000, expiresAt: now }), identity, { now });
	assert.equal(backwards.ok, false);
	assert.match(backwards.reason, /after createdAt/);
});

test("control dispatcher: stop_all, stop_one, idempotent request ids, bounded acks", async () => {
	const cwd = await makeCwd();
	try {
		const registry = await WebActivityRegistry.create({ cwd, identity, env: webEnv, runGit: noRepoGit() });
		const calls = [];
		const dispatcher = new ControlDispatcher(registry, identity, {
			stopOne: async (jobId) => {
				calls.push(["one", jobId]);
				return `stopped ${jobId}`;
			},
			stopAll: async () => {
				calls.push(["all"]);
				return "stopped all";
			},
		});
		const requestsDir = path.join(registry.root, "requests");
		await mkdir(requestsDir, { recursive: true });
		const publish = async (requestId, data) =>
			writeFile(path.join(requestsDir, `${requestId}.json`), JSON.stringify(data), "utf8");

		// stop_all executes exactly once and gets a bounded ack.
		await publish("req-1", validRequest({ requestId: "req-1" }));
		assert.equal(await dispatcher.poll(), 1);
		assert.deepEqual(calls, [["all"]]);
		const ack = JSON.parse(await readFile(path.join(registry.root, "acks", "req-1.json"), "utf8"));
		assert.equal(ack.accepted, true);
		assert.equal(ack.requestId, "req-1");
		assert.equal(ack.action, "stop_all");

		// Replaying the same request id (even with fresh timestamps) is idempotent.
		await publish("req-1", validRequest({ requestId: "req-1" }));
		assert.equal(await dispatcher.poll(), 0);
		assert.equal(calls.length, 1);

		// An invalid token is acked as rejected and never executes.
		await publish("req-2", validRequest({ requestId: "req-2", controlToken: "wrong" }));
		assert.equal(await dispatcher.poll(), 0);
		const rejected = JSON.parse(await readFile(path.join(registry.root, "acks", "req-2.json"), "utf8"));
		assert.equal(rejected.accepted, false);
		assert.match(rejected.reason, /controlToken/);
		assert.equal(calls.length, 1);

		// stop_one with a jobId executes through the same validated pipeline.
		await publish("req-3", validRequest({ requestId: "req-3", action: "stop_one", jobId: "sa-j1" }));
		assert.equal(await dispatcher.poll(), 1);
		assert.deepEqual(calls.at(-1), ["one", "sa-j1"]);

		// Polling an unchanged request set executes nothing new.
		assert.equal(await dispatcher.poll(), 0);
		assert.equal(calls.length, 2);

		// Oversized request files are ignored entirely.
		await publish("req-4", validRequest({ requestId: "req-4" }));
		await writeFile(path.join(requestsDir, "req-5.json"), JSON.stringify(validRequest({ requestId: "req-5", blob: "z".repeat(20_000) })), "utf8");
		assert.equal(await dispatcher.poll(), 1);
		assert.equal(calls.length, 3);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("sessions/runtimes partition records and never consume each other's requests/acks", async () => {
	const cwd = await makeCwd();
	try {
		const makeIdentity = (sessionId, runtimeId) => ({
			sessionId,
			runtimeId,
			generation: 1,
			controlToken: `tok-${runtimeId}`,
		});
		const a = await WebActivityRegistry.create({
			cwd,
			identity: makeIdentity("sess-a", "rt-a"),
			env: webEnv,
			runGit: noRepoGit(),
		});
		const b = await WebActivityRegistry.create({
			cwd,
			identity: makeIdentity("sess-b", "rt-b"),
			env: webEnv,
			runGit: noRepoGit(),
		});
		assert.notEqual(a.root, b.root);
		assert.equal(a.root, path.join(cwd, ".pi", ".runtime", "pi-web-activity", "v1", "sessions", "sess-a", "runtimes", "rt-a"));
		assert.equal(b.root, path.join(cwd, ".pi", ".runtime", "pi-web-activity", "v1", "sessions", "sess-b", "runtimes", "rt-b"));

		// Distinct records never clobber each other.
		assert.equal(await a.write("runtime", { owner: "a" }), true);
		assert.equal(await b.write("runtime", { owner: "b" }), true);
		assert.equal(JSON.parse(await readFile(path.join(a.root, "runtime.json"), "utf8")).owner, "a");
		assert.equal(JSON.parse(await readFile(path.join(b.root, "runtime.json"), "utf8")).owner, "b");

		// A control request published to B is invisible to A's dispatcher.
		const requestsDirB = path.join(b.root, "requests");
		await mkdir(requestsDirB, { recursive: true });
		const reqB = validRequest({
			sessionId: "sess-b",
			runtimeId: "rt-b",
			generation: 1,
			controlToken: "tok-rt-b",
			requestId: "req-b1",
		});
		await writeFile(path.join(requestsDirB, "req-b1.json"), JSON.stringify(reqB), "utf8");

		const callsA = [];
		const dispA = new ControlDispatcher(a, a.identity, {
			stopOne: () => (callsA.push("one"), "x"),
			stopAll: () => (callsA.push("all"), "x"),
		});
		assert.equal(await dispA.poll(), 0);
		assert.deepEqual(callsA, []);
		assert.equal(await a.hasAck("req-b1"), false);

		// B's own dispatcher executes and acks the request exactly once.
		const callsB = [];
		const dispB = new ControlDispatcher(b, b.identity, {
			stopOne: () => (callsB.push("one"), "x"),
			stopAll: () => (callsB.push("all"), "x"),
		});
		assert.equal(await dispB.poll(), 1);
		assert.deepEqual(callsB, ["all"]);
		assert.equal(await b.hasAck("req-b1"), true);
		assert.equal(await a.hasAck("req-b1"), false);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("pruneOwnControlFiles only removes this runtime's stale control files", async () => {
	const cwd = await makeCwd();
	try {
		const makeIdentity = (sessionId, runtimeId) => ({
			sessionId,
			runtimeId,
			generation: 1,
			controlToken: `tok-${runtimeId}`,
		});
		const a = await WebActivityRegistry.create({ cwd, identity: makeIdentity("sess-a", "rt-a"), env: webEnv, runGit: noRepoGit() });
		const b = await WebActivityRegistry.create({ cwd, identity: makeIdentity("sess-b", "rt-b"), env: webEnv, runGit: noRepoGit() });

		// Publish a request + ack into A's dirs and a request into B's dirs.
		await mkdir(path.join(a.root, "requests"), { recursive: true });
		await mkdir(path.join(a.root, "acks"), { recursive: true });
		await mkdir(path.join(b.root, "requests"), { recursive: true });
		await writeFile(path.join(a.root, "requests", "ra.json"), JSON.stringify({ requestId: "ra" }), "utf8");
		await writeFile(path.join(a.root, "acks", "ra.json"), JSON.stringify({ accepted: true }), "utf8");
		await writeFile(path.join(b.root, "requests", "rb.json"), JSON.stringify({ requestId: "rb" }), "utf8");

		// Backdate every file beyond the default 24h window.
		const stale = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
		await utimes(path.join(a.root, "requests", "ra.json"), stale, stale);
		await utimes(path.join(a.root, "acks", "ra.json"), stale, stale);
		await utimes(path.join(b.root, "requests", "rb.json"), stale, stale);

		// A prunes only its own stale files; B's are untouched.
		await a.pruneOwnControlFiles();
		assert.equal(await stat(path.join(a.root, "requests", "ra.json")).then(() => true).catch(() => false), false);
		assert.equal(await stat(path.join(a.root, "acks", "ra.json")).then(() => true).catch(() => false), false);
		assert.equal(await stat(path.join(b.root, "requests", "rb.json")).then(() => true).catch(() => false), true);

		// Fresh files survive the default 24h window.
		await writeFile(path.join(a.root, "requests", "keep.json"), JSON.stringify({ requestId: "keep" }), "utf8");
		await a.pruneOwnControlFiles();
		assert.equal(await stat(path.join(a.root, "requests", "keep.json")).then(() => true).catch(() => false), true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("dispatcher is a no-op when the registry is disabled", async () => {
	const cwd = await makeCwd();
	try {
		const registry = await WebActivityRegistry.create({ cwd, identity, env: {} });
		const calls = [];
		const dispatcher = new ControlDispatcher(registry, identity, {
			stopOne: () => (calls.push("one"), "x"),
			stopAll: () => (calls.push("all"), "x"),
		});
		assert.equal(await dispatcher.poll(), 0);
		assert.equal(calls.length, 0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("buildControlAck bounds the reason and echoes identity", () => {
	const ack = buildControlAck({ requestId: "req-9", accepted: true, reason: "r".repeat(3000), action: "stop_all" }, identity, 1234);
	assert.equal(ack.requestId, "req-9");
	assert.equal(ack.accepted, true);
	assert.equal(ack.reason.length, 1000);
	assert.equal(ack.respondedAt, 1234);
	assert.equal(ack.sessionId, identity.sessionId);
});
