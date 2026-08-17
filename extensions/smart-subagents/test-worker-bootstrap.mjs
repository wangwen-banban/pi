import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPiInvocation } from "./pi-invocation.ts";
import { DEFAULT_CONFIG, mergeConfig } from "./router.ts";
import {
	WORKER_EXTENSION_KEYS,
	WORKER_EXTENSIONS,
	buildWorkerArgs,
	fetchFailureHint,
	isUnsupportedModelFailure,
	mayFallbackAfterFailure,
	preflightWorkerProvider,
	resolveWorkerExtensions,
	sanitizeWorkerExtensionKeys,
} from "./worker-bootstrap.ts";

// ---------------------------------------------------------------------------
// Config merge: default, order, dedupe; unknown/traversal-like keys rejected
// ---------------------------------------------------------------------------

test("default config carries the trusted worker extensions in fixed order", () => {
	assert.deepEqual(DEFAULT_CONFIG.execution.workerExtensions, ["codex-multi-account", "provider-routing"]);
	assert.deepEqual(WORKER_EXTENSION_KEYS, ["codex-multi-account", "provider-routing"]);
	assert.equal(WORKER_EXTENSIONS["codex-multi-account"].order, 0);
	assert.equal(WORKER_EXTENSIONS["provider-routing"].order, 1);
});

test("mergeConfig dedupes, sorts into fixed order, and drops unknown/traversal-like keys", () => {
	const merged = mergeConfig({
		execution: {
			workerExtensions: [
				"provider-routing",
				"codex-multi-account",
				"codex-multi-account",
				"unknown-key",
				"../evil",
				"/absolute/path",
				"~/home/path",
				"extensions/provider-routing",
				"provider-routing/index.ts",
				42,
			],
		},
	});
	assert.deepEqual(merged.execution.workerExtensions, ["codex-multi-account", "provider-routing"]);
	// Missing config keeps the default.
	assert.deepEqual(mergeConfig({}).execution.workerExtensions, ["codex-multi-account", "provider-routing"]);
	// An explicit empty list disables the bootstrap (preflight still gates routed providers).
	assert.deepEqual(mergeConfig({ execution: { workerExtensions: [] } }).execution.workerExtensions, []);
});

test("sanitizeWorkerExtensionKeys never lets a path-shaped string through", () => {
	assert.deepEqual(sanitizeWorkerExtensionKeys(["provider-routing", "provider-routing", "nope"]), ["provider-routing"]);
	assert.deepEqual(sanitizeWorkerExtensionKeys(["../codex-multi-account", "/etc/passwd", "~/.pi/agent/x", ""]), []);
});

test("resolveWorkerExtensions rejects unknown and traversal-like keys", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ws-keys-"));
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	for (const key of ["unknown-key", "../evil", "/abs/path", "~/home/path", "extensions/provider-routing", "provider-routing/index.ts", ""]) {
		assert.throws(
			() => resolveWorkerExtensions([key], agentDir),
			/Unknown worker extension key/,
			`expected rejection for key ${JSON.stringify(key)}`,
		);
	}
	// A valid key followed by an unknown one still fails instead of silently skipping.
	const withFiles = makeAgentDirWithExtensions();
	assert.throws(
		() => resolveWorkerExtensions(["codex-multi-account", "../evil"], withFiles.agentDir),
		/Unknown worker extension key/,
	);
});

// ---------------------------------------------------------------------------
// Resolution: realpath, containment, regular-file checks
// ---------------------------------------------------------------------------

function makeAgentDirWithExtensions() {
	const agentDir = mkdtempSync(join(tmpdir(), "ws-ok-"));
	const codexDir = join(agentDir, "extensions", "codex-multi-account");
	const routingDir = join(agentDir, "extensions", "provider-routing");
	mkdirSync(codexDir, { recursive: true });
	mkdirSync(routingDir, { recursive: true });
	const codexFile = join(codexDir, "index.ts");
	const routingFile = join(routingDir, "index.ts");
	writeFileSync(codexFile, "export default () => {};\n");
	writeFileSync(routingFile, "export default () => {};\n");
	return { agentDir, codexFile, routingFile };
}

test("resolveWorkerExtensions realpaths files and forces fixed order regardless of input", () => {
	const { agentDir, codexFile, routingFile } = makeAgentDirWithExtensions();
	const resolved = resolveWorkerExtensions(["codex-multi-account", "provider-routing"], agentDir);
	assert.deepEqual(resolved, [
		{ key: "codex-multi-account", file: realpathSync(codexFile) },
		{ key: "provider-routing", file: realpathSync(routingFile) },
	]);
	const reversed = resolveWorkerExtensions(["provider-routing", "codex-multi-account"], agentDir);
	assert.deepEqual(reversed.map((entry) => entry.key), ["codex-multi-account", "provider-routing"]);
});

test("resolveWorkerExtensions fails on a missing extensions root or missing file", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ws-missing-"));
	assert.throws(
		() => resolveWorkerExtensions(["codex-multi-account"], agentDir),
		/extensions directory is missing/,
	);
	mkdirSync(join(agentDir, "extensions"), { recursive: true });
	assert.throws(
		() => resolveWorkerExtensions(["codex-multi-account"], agentDir),
		/could not be resolved/,
	);
});

test("resolveWorkerExtensions rejects non-regular files", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ws-dir-"));
	mkdirSync(join(agentDir, "extensions", "codex-multi-account", "index.ts"), { recursive: true });
	assert.throws(
		() => resolveWorkerExtensions(["codex-multi-account"], agentDir),
		/not a regular file/,
	);
});

test("resolveWorkerExtensions rejects symlinks escaping the extensions root", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ws-escape-"));
	const outside = mkdtempSync(join(tmpdir(), "ws-outside-"));
	mkdirSync(join(agentDir, "extensions", "provider-routing"), { recursive: true });
	writeFileSync(join(outside, "evil.ts"), "export default () => {};\n");
	symlinkSync(join(outside, "evil.ts"), join(agentDir, "extensions", "provider-routing", "index.ts"));
	assert.throws(
		() => resolveWorkerExtensions(["provider-routing"], agentDir),
		/outside the extensions directory/,
	);
});

test("resolveWorkerExtensions accepts symlinks that stay inside the root", () => {
	const agentDir = mkdtempSync(join(tmpdir(), "ws-internal-"));
	const codexDir = join(agentDir, "extensions", "codex-multi-account");
	mkdirSync(codexDir, { recursive: true });
	mkdirSync(join(agentDir, "extensions", "provider-routing"), { recursive: true });
	writeFileSync(join(codexDir, "real.ts"), "export default () => {};\n");
	symlinkSync(join(codexDir, "real.ts"), join(codexDir, "index.ts"));
	writeFileSync(join(agentDir, "extensions", "provider-routing", "index.ts"), "export default () => {};\n");
	const resolved = resolveWorkerExtensions(["codex-multi-account", "provider-routing"], agentDir);
	assert.equal(resolved[0].file, realpathSync(join(codexDir, "real.ts")));
});

// ---------------------------------------------------------------------------
// Argument vector
// ---------------------------------------------------------------------------

function sampleExtensions() {
	return [
		{ key: "codex-multi-account", file: "/agent/extensions/codex-multi-account/index.ts" },
		{ key: "provider-routing", file: "/agent/extensions/provider-routing/index.ts" },
	];
}

test("buildWorkerArgs keeps --no-extensions, inserts exactly two ordered -e pairs before --model, never smart-subagents, prompt last", () => {
	const args = buildWorkerArgs({
		modelRef: "openai-codex-second/gpt-5.6-luna",
		effort: "xhigh",
		tools: "read,bash,edit,write",
		contextPath: "/tmp/run/context.md",
		prompt: "do the thing",
		extensions: sampleExtensions(),
	});
	assert.ok(args.includes("--no-extensions"), "keeps --no-extensions");
	assert.equal(args.filter((arg) => arg === "-e").length, 2, "exactly two -e pairs");
	const noExtIndex = args.indexOf("--no-extensions");
	assert.deepEqual(args.slice(noExtIndex + 1, noExtIndex + 5), [
		"-e",
		"/agent/extensions/codex-multi-account/index.ts",
		"-e",
		"/agent/extensions/provider-routing/index.ts",
	]);
	const modelIndex = args.indexOf("--model");
	assert.ok(modelIndex > noExtIndex + 4, "all -e pairs come before --model");
	assert.equal(args[args.length - 1], "do the thing", "prompt is the last positional argument");
	assert.ok(!args.some((arg) => arg.includes("smart-subagents")), "smart-subagents is never loaded");
	assert.deepEqual(args.slice(modelIndex), [
		"--model", "openai-codex-second/gpt-5.6-luna",
		"--thinking", "xhigh",
		"--tools", "read,bash,edit,write",
		"--append-system-prompt", "/tmp/run/context.md",
		"do the thing",
	]);
});

test("buildWorkerArgs emits no -e pairs when the bootstrap list is empty", () => {
	const args = buildWorkerArgs({
		modelRef: "opencode-go/deepseek-v4-pro",
		effort: "high",
		tools: "read,grep",
		contextPath: "/tmp/context.md",
		prompt: "hi",
		extensions: [],
	});
	assert.ok(args.includes("--no-extensions"));
	assert.equal(args.filter((arg) => arg === "-e").length, 0);
});

// ---------------------------------------------------------------------------
// Provider preflight (no network)
// ---------------------------------------------------------------------------

test("preflightWorkerProvider gates extension-dependent providers and lets builtins continue", () => {
	const both = ["codex-multi-account", "provider-routing"];
	assert.equal(preflightWorkerProvider("opencode-go", []), null);
	assert.equal(preflightWorkerProvider("anthropic", []), null);
	assert.equal(preflightWorkerProvider("openai-codex", both), null);
	assert.equal(preflightWorkerProvider("openai-codex-second", both), null);
	assert.equal(preflightWorkerProvider("claude-relay", ["provider-routing"]), null);
	assert.equal(preflightWorkerProvider("claude-relay-alibaba", ["provider-routing"]), null);
	assert.equal(preflightWorkerProvider("big-data-claude", ["provider-routing"]), null);

	const primaryMissing = preflightWorkerProvider("openai-codex", ["codex-multi-account"]);
	assert.match(primaryMissing, /provider-routing/);
	assert.match(primaryMissing, /execution\.workerExtensions/);
	assert.match(primaryMissing, /before spawn/);

	const secondaryMissing = preflightWorkerProvider("openai-codex-second", ["provider-routing"]);
	assert.match(secondaryMissing, /codex-multi-account/);

	const none = preflightWorkerProvider("big-data-claude", []);
	assert.match(none, /provider-routing/);
});

// ---------------------------------------------------------------------------
// Fallback gating and fetch diagnostics (no retry after side effects)
// ---------------------------------------------------------------------------

test("fallback fires only for unsupported-model failures with no tool activity and no edits", () => {
	const base = {
		terminationReason: "exit_nonzero",
		toolActivitySeen: false,
		changedFileCount: 0,
		fallbackRouteCount: 1,
	};
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "requested model is not supported" }), true);
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "model_not_supported" }), true);
	// Generic fetch failure must never silently fall back.
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "Error: fetch failed" }), false);
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "ECONNREFUSED 127.0.0.1:443" }), false);
	// Tool activity or edits block fallback even for unsupported-model text.
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "unsupported model", toolActivitySeen: true }), false);
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "unsupported model", changedFileCount: 1 }), false);
	// No fallback candidates.
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "unsupported model", fallbackRouteCount: 0 }), false);
	// Non-terminal reasons never fall back.
	assert.equal(mayFallbackAfterFailure({ ...base, failureText: "unsupported model", terminationReason: "timed_out" }), false);
});

test("isUnsupportedModelFailure matches only the legacy unsupported-model signals", () => {
	assert.equal(isUnsupportedModelFailure("model not supported by provider"), true);
	assert.equal(isUnsupportedModelFailure("Model_Not_Supported"), true);
	assert.equal(isUnsupportedModelFailure("fetch failed"), false);
});

test("fetchFailureHint is bounded, mentions the worker bootstrap, and exposes no secrets", () => {
	const hint = fetchFailureHint("Error: fetch failed");
	assert.ok(hint, "hint produced for fetch failure");
	assert.match(hint, /worker/i);
	assert.match(hint, /execution\.workerExtensions/);
	assert.match(hint, /codex-multi-account/);
	assert.match(hint, /provider-routing/);
	assert.ok(hint.split("\n").length <= 4, "hint is bounded");
	assert.doesNotMatch(hint, /http:\/\/127\.0\.0\.1|proxyUrl|token|api[_-]?key|secret|Bearer/i);
	assert.equal(fetchFailureHint("unsupported model"), null);
	assert.equal(fetchFailureHint("exit code 1"), null);
	assert.equal(fetchFailureHint(""), null);
});

test("smart-subagents index wires trusted bootstrap, preflight, tool-activity gating and fetch diagnostics", () => {
	const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
	assert.match(source, /buildWorkerArgs\(/);
	assert.match(source, /resolveWorkerExtensions\(/);
	assert.match(source, /preflightWorkerProvider\(/);
	assert.match(source, /mayFallbackAfterFailure\(/);
	assert.match(source, /fetchFailureHint\(/);
	assert.match(source, /toolActivitySeen = true/);
	assert.match(source, /routing_error/);
	assert.match(source, /getAgentDir\(\)/);
});

// ---------------------------------------------------------------------------
// Offline bounded smoke against the exact installed pi CLI (0.84.1)
// ---------------------------------------------------------------------------

test("offline smoke: installed pi --list-models registers both worker providers with no network", async () => {
	const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
	const resolved = resolveWorkerExtensions(["codex-multi-account", "provider-routing"], agentDir);
	assert.equal(resolved.length, 2, "both trusted worker extensions resolve under the agent dir");

	const listArgs = [
		...buildWorkerArgs({
			modelRef: "unused",
			effort: "low",
			tools: "",
			contextPath: "/unused/context.md",
			prompt: "unused",
			extensions: resolved,
		}).slice(0, 9), // --mode json -p --no-session --no-extensions -e <f1> -e <f2>
		"--list-models",
	];
	assert.deepEqual(
		listArgs.filter((arg) => arg === "-e"),
		["-e", "-e"],
		"smoke carries exactly two -e pairs",
	);

	// Poison every proxy variable so any successful network call is
	// impossible; --list-models must still succeed, proving the bootstrap and
	// model registration are offline.
	const env = {
		...process.env,
		HTTP_PROXY: "http://127.0.0.1:1",
		HTTPS_PROXY: "http://127.0.0.1:1",
		ALL_PROXY: "http://127.0.0.1:1",
		http_proxy: "http://127.0.0.1:1",
		https_proxy: "http://127.0.0.1:1",
		all_proxy: "http://127.0.0.1:1",
	};

	const run = async (args) => {
		const invocation = getPiInvocation(args);
		const child = spawn(invocation.command, invocation.args, {
			cwd: agentDir,
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout.on("data", (chunk) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk) => { output += chunk.toString(); });
		const killer = setTimeout(() => child.kill("SIGKILL"), 90_000);
		const code = await new Promise((resolveClose) => child.on("close", (c) => resolveClose(c)));
		clearTimeout(killer);
		return { code, output };
	};

	const version = await run(["--version"]);
	assert.equal(version.code, 0, `pi --version failed: ${version.output.slice(0, 400)}`);
	assert.match(version.output, /0\.84\.1/, "smoke must exercise the exact installed pi 0.84.1");

	const listing = await run(listArgs);
	assert.equal(listing.code, 0, `pi --list-models exited ${listing.code}:\n${listing.output.slice(0, 1000)}`);
	assert.match(listing.output, /openai-codex\s/, "primary openai-codex provider is registered");
	assert.match(listing.output, /openai-codex-second\s+gpt-/, "secondary provider registered with models (codex-multi-account loaded)");
});
