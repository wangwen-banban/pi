import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { getNewApiCachePath, readNewApiCache, writeNewApiCache } from "./cache.ts";
import {
	getNewApiProviderId,
	parseNewApiUsage,
	requestNewApiUsage,
	selectSharedNewApiKey,
	sharedNewApiRoot,
} from "./usage.ts";
import { readSubscriptionQuota, SUBSCRIPTION_PROVIDERS } from "../custom-statusline/quota.ts";

const limitedPayload = {
	code: true,
	data: {
		expires_at: 1_800_000_000,
		model_limits: {},
		model_limits_enabled: false,
		total_available: 40,
		total_granted: 100,
		total_used: 60,
		unlimited_quota: false,
	},
	message: "ok",
};

function listen(server) {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve(server.address().port));
	});
}
function close(server) { return new Promise((resolve) => server.close(resolve)); }

function privateAgentDir() {
	const dir = mkdtempSync(join(tmpdir(), "pi-newapi-status-"));
	mkdirSync(join(dir, "cache"), { mode: 0o700 });
	return dir;
}

test("provider aliases normalize to one safe NewAPI root", () => {
	assert.equal(getNewApiProviderId("cambricon-codex"), "cambricon-codex");
	assert.equal(getNewApiProviderId("claude-cambricon"), "claude-cambricon");
	assert.equal(getNewApiProviderId("claude-custom"), undefined);
	assert.equal(selectSharedNewApiKey("same-secret", "same-secret"), "same-secret");
	assert.equal(selectSharedNewApiKey("only-one", undefined), "only-one");
	assert.equal(selectSharedNewApiKey("first", "second"), undefined);
	assert.equal(sharedNewApiRoot({
		"cambricon-codex": { baseUrl: "http://127.0.0.1:1234/v1/" },
		"claude-cambricon": { baseUrl: "http://127.0.0.1:1234" },
	}), "http://127.0.0.1:1234");
	for (const bad of [
		{ "cambricon-codex": { baseUrl: "http://a.test/v1" }, "claude-cambricon": { baseUrl: "http://b.test" } },
		{ "cambricon-codex": { baseUrl: "http://user@a.test/v1" }, "claude-cambricon": { baseUrl: "http://a.test" } },
		{ "cambricon-codex": { baseUrl: "http://a.test/other" }, "claude-cambricon": { baseUrl: "http://a.test" } },
	]) assert.equal(sharedNewApiRoot(bad), undefined);
});

test("usage parser distinguishes limited, unlimited and incoherent payloads", () => {
	const limited = parseNewApiUsage(limitedPayload, 1234);
	assert.equal(limited.remainingPercent, 40);
	assert.equal(limited.totalUsed, 60);
	assert.equal(limited.source, "api");
	assert.equal(parseNewApiUsage({ code: true, data: { unlimited_quota: true } }, 1234).unlimited, true);
	for (const bad of [
		null,
		{ ...limitedPayload, code: false },
		{ code: true, data: { ...limitedPayload.data, total_available: 41 } },
		{ code: true, data: { ...limitedPayload.data, total_granted: 0 } },
	]) assert.equal(parseNewApiUsage(bad), undefined);
});

test("direct HTTP request ignores proxy env, authenticates, enforces slash/cap/timeout", async () => {
	let pathSeen;
	let authSeen;
	const server = http.createServer((request, response) => {
		pathSeen = request.url;
		authSeen = request.headers.authorization;
		if (request.url === "/slow/") return;
		if (request.url === "/api/usage/token/") {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify(limitedPayload));
			return;
		}
		response.end(JSON.stringify({ ...limitedPayload, padding: "x".repeat(1024) }));
	});
	const port = await listen(server);
	const previous = process.env.HTTP_PROXY;
	process.env.HTTP_PROXY = "http://127.0.0.1:1";
	try {
		const usage = await requestNewApiUsage(`http://127.0.0.1:${port}`, "fixture-secret", { timeoutMs: 500 });
		assert.equal(usage.remainingPercent, 40);
		assert.equal(pathSeen, "/api/usage/token/");
		assert.equal(authSeen, "Bearer fixture-secret");
		await assert.rejects(
			requestNewApiUsage(`http://127.0.0.1:${port}/other/`, "fixture-secret", { maxBytes: 32 }),
			/size limit|invalid/,
		);
	} finally {
		if (previous === undefined) delete process.env.HTTP_PROXY;
		else process.env.HTTP_PROXY = previous;
		await close(server);
	}

	const slow = http.createServer(() => {});
	const slowPort = await listen(slow);
	try {
		// requestNewApiUsage always targets /api/usage/token/; this server never responds.
		await assert.rejects(requestNewApiUsage(`http://127.0.0.1:${slowPort}`, "fixture", { timeoutMs: 20 }), /timed out/);
	} finally { await close(slow); }
});

test("private atomic cache is shared by both aliases and contains no sensitive fields", () => {
	const dir = privateAgentDir();
	const usage = parseNewApiUsage(limitedPayload, Date.now());
	writeNewApiCache(usage, dir);
	const file = getNewApiCachePath(dir);
	assert.equal(lstatSync(file).mode & 0o777, 0o600);
	assert.equal(lstatSync(join(dir, "cache")).mode & 0o777, 0o700);
	const raw = readFileSync(file, "utf8");
	for (const forbidden of ["fixture-secret", "43.143", "cambricon-codex", "claude-cambricon", "model_limits", "name"]) {
		assert.equal(raw.includes(forbidden), false);
	}
	assert.equal(readNewApiCache(dir).source, "cache");
	assert.equal(SUBSCRIPTION_PROVIDERS["cambricon-codex"].cacheFile(dir), file);
	assert.equal(SUBSCRIPTION_PROVIDERS["claude-cambricon"].cacheFile(dir), file);
	assert.equal(readSubscriptionQuota(dir, "cambricon-codex").remaining, 40);
	assert.equal(readSubscriptionQuota(dir, "claude-cambricon").remaining, 40);
	writeFileSync(file, JSON.stringify({ ...JSON.parse(raw), totalAvailable: 41 }));
	assert.equal(readNewApiCache(dir), undefined, "incoherent cached totals must fail closed");
	writeNewApiCache(usage, dir);

	const badDir = privateAgentDir();
	const target = join(badDir, "target.json");
	writeFileSync(target, "{}", { mode: 0o600 });
	symlinkSync(target, getNewApiCachePath(badDir));
	assert.throws(() => writeNewApiCache(usage, badDir), /private regular file/);

	chmodSync(file, 0o644);
	assert.equal(readNewApiCache(dir), undefined);
	assert.throws(() => writeNewApiCache(usage, dir), /private regular file/);
});

test("extension shares one refresh across aliases and clears status elsewhere", async () => {
	let requests = 0;
	const server = http.createServer((request, response) => {
		requests += 1;
		response.setHeader("content-type", "application/json");
		response.end(JSON.stringify(limitedPayload));
	});
	const port = await listen(server);
	const dir = privateAgentDir();
	writeFileSync(join(dir, "provider-routing.json"), JSON.stringify({ providers: {
		"cambricon-codex": { baseUrl: `http://127.0.0.1:${port}/v1` },
		"claude-cambricon": { baseUrl: `http://127.0.0.1:${port}` },
	} }));
	const oldDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
		const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
		const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
		const eventBus = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
		const runtime = loader.createExtensionRuntime();
		const loaded = await loader.loadExtensions([new URL(`./index.ts?test=${Date.now()}`, import.meta.url).pathname], process.cwd(), eventBus.createEventBus(), runtime);
		assert.deepEqual(loaded.errors, []);
		const extension = loaded.extensions[0];
		const statuses = [];
		const notifications = [];
		const ctx = {
			mode: "tui",
			model: { provider: "cambricon-codex" },
			modelRegistry: { async getApiKeyForProvider() { return "shared-fixture-key"; } },
			ui: {
				theme: { fg: (_tone, text) => text },
				setStatus: (key, value) => statuses.push({ key, value }),
				notify: (message, level) => notifications.push({ message, level }),
			},
		};
		const fire = async (name, payload = {}) => {
			for (const handler of extension.handlers.get(name) ?? []) await handler({ type: name, ...payload }, ctx);
		};
		await fire("session_start");
		for (let i = 0; i < 50 && requests < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(requests, 1);
		assert.match(statuses.at(-1).value, /newapi 40% remaining/);
		await fire("model_select", { model: { provider: "claude-cambricon" } });
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(requests, 1, "alias switch must share the refresh gap");
		ctx.model = { provider: "claude-cambricon" };
		await extension.commands.get("newapi").handler("", ctx);
		assert.equal(requests, 2);
		assert.match(notifications.at(-1).message, /40% remaining/);
		await fire("model_select", { model: { provider: "openai-codex-second" } });
		assert.equal(statuses.at(-1).value, undefined);
		await fire("session_shutdown");
	} finally {
		if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = oldDir;
		await close(server);
	}
});

test("model configuration uses live NewAPI ids and gives Astra a 1M override", () => {
	const models = JSON.parse(readFileSync(new URL("../../models.json", import.meta.url), "utf8")).providers;
	for (const provider of ["openai-codex", "openai-codex-second"]) {
		assert.equal(models[provider].modelOverrides["gpt-6-astra"].contextWindow, 1_000_000);
	}
	assert.deepEqual(Object.keys(models["cambricon-codex"].modelOverrides), [
		"gpt-5.3-codex-spark", "gpt-5.6-luna", "gpt-5.6-terra", "gpt-5.6-sol", "gpt-6-astra",
	]);
	assert.equal(models["claude-cambricon"].modelOverrides.k3.contextWindow, 1_000_000);
	const routing = JSON.parse(readFileSync(new URL("../../provider-routing.json", import.meta.url), "utf8")).providers;
	assert.equal(routing["claude-cambricon"].modelId, "k3");
	assert.equal(routing["claude-cambricon"].requestModelId, "k3");
});
