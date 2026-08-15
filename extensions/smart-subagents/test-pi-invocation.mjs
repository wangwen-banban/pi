import assert from "node:assert/strict";
import test from "node:test";
import { getPiInvocation } from "./pi-invocation.ts";

const workerArgs = ["--mode", "json", "-p", "--no-session", "--no-extensions", "hello"];

function runtime(overrides = {}) {
	return {
		argv1: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
		execPath: "/opt/homebrew/bin/node",
		env: {},
		scriptExists: () => true,
		...overrides,
	};
}

test("normal Pi CLI reuses its current script", () => {
	const result = getPiInvocation(workerArgs, runtime());
	assert.deepEqual(result, {
		command: "/opt/homebrew/bin/node",
		args: [
			"/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
			...workerArgs,
		],
	});
});

test("PI WEB embedded runtime never launches sessiond.js as a worker", () => {
	const sessiondScript = "/opt/homebrew/lib/node_modules/@jmfederico/pi-web/dist/server/sessiond.js";
	const result = getPiInvocation(
		workerArgs,
		runtime({
			argv1: sessiondScript,
			env: { PI_WEB_SESSION: "1" },
		}),
	);

	assert.deepEqual(result, { command: "pi", args: workerArgs });
	assert.notEqual(result.command, sessiondScript);
	assert.ok(!result.args.includes(sessiondScript));
});

test("compiled Pi binary executes itself even inside PI WEB", () => {
	const result = getPiInvocation(
		workerArgs,
		runtime({
			argv1: "/opt/pi-web/dist/server/sessiond.js",
			execPath: "/opt/bin/pi",
			env: { PI_WEB_SESSION: "1" },
		}),
	);
	assert.deepEqual(result, { command: "/opt/bin/pi", args: workerArgs });
});

test("Bun virtual scripts fall back to the pi command", () => {
	const result = getPiInvocation(
		workerArgs,
		runtime({
			argv1: "/$bunfs/root/pi/cli.js",
			execPath: "/opt/homebrew/bin/bun",
		}),
	);
	assert.deepEqual(result, { command: "pi", args: workerArgs });
});

test("missing current script falls back to the pi command", () => {
	const result = getPiInvocation(
		workerArgs,
		runtime({ scriptExists: () => false }),
	);
	assert.deepEqual(result, { command: "pi", args: workerArgs });
});
