import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import {
	mergeCodexModels,
	parseCodexCatalog,
	projectCodexModel,
	readStoredCodexModels,
	refreshSecondaryCodexModels,
} from "./catalog.ts";

const astra = {
	id: "gpt-6-astra",
	name: "GPT-6 Astra",
	api: "openai-codex-responses",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	reasoning: true,
	input: ["text", "image"],
	cost: { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
	contextWindow: 272000,
	maxTokens: 128000,
	thinkingLevelMap: { off: null, minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
	compat: { supportsAdditionalTools: true },
};

const luna = { ...astra, id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };

test("catalog parser projects a bounded Codex catalog and keeps Astra", () => {
	const parsed = parseCodexCatalog({ [luna.id]: luna, [astra.id]: astra });
	assert.deepEqual(parsed.map((model) => model.id), ["gpt-5.6-luna", "gpt-6-astra"]);
	assert.equal(parsed[1].provider, undefined);
	assert.equal(parsed[1].baseUrl, undefined);
	assert.equal(parsed[1].thinkingLevelMap.max, "max");
	assert.equal(projectCodexModel({ ...astra, api: "openai-responses" }), undefined);
	assert.throws(() => parseCodexCatalog({ [astra.id]: astra, invalid: { id: "bad model" } }), /invalid model/);
});

test("stored primary or secondary overlay is available during extension startup", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-secondary-catalog-"));
	writeFileSync(join(dir, "models-store.json"), JSON.stringify({
		"openai-codex-second": { models: [luna], checkedAt: 1 },
		"openai-codex": { models: [luna, astra], checkedAt: 2 },
	}));
	assert.deepEqual(readStoredCodexModels(dir).map((model) => model.id), ["gpt-5.6-luna", "gpt-6-astra"]);
	const merged = mergeCodexModels([luna], readStoredCodexModels(dir));
	assert.deepEqual(merged.map((model) => model.id), ["gpt-5.6-luna", "gpt-6-astra"]);
});

test("refresh publishes a secondary-provider catalog and supports 304/offline", async () => {
	let publication;
	let fetches = 0;
	const controller = new AbortController();
	const context = {
		allowNetwork: true,
		signal: controller.signal,
		stored: undefined,
		async publish(value) { publication = value; return true; },
	};
	const refreshed = await refreshSecondaryCodexModels(
		context,
		"https://chatgpt.com/backend-api",
		[luna],
		async () => {
			fetches += 1;
			return new Response(JSON.stringify({ [luna.id]: luna, [astra.id]: astra }), {
				status: 200,
				headers: { etag: '"catalog-v2"', "last-modified": "Wed, 01 Jan 2025 00:00:00 GMT" },
			});
		},
	);
	assert.equal(fetches, 1);
	assert.deepEqual(refreshed.map((model) => model.id), ["gpt-5.6-luna", "gpt-6-astra"]);
	assert(publication.persist.models.every((model) => model.provider === "openai-codex-second"));
	assert(publication.persist.models.every((model) => model.baseUrl === "https://chatgpt.com/backend-api"));

	const stored = publication.persist;
	let revalidated;
	const unchanged = await refreshSecondaryCodexModels({
		...context,
		stored,
		async publish(value) { revalidated = value; return true; },
	}, "https://chatgpt.com/backend-api", [], async (_url, init) => {
		assert.equal(init.headers["if-none-match"], '"catalog-v2"');
		return new Response(null, { status: 304 });
	});
	assert.deepEqual(unchanged.map((model) => model.id), ["gpt-5.6-luna", "gpt-6-astra"]);
	assert(revalidated.persist.checkedAt >= stored.checkedAt);

	const offline = await refreshSecondaryCodexModels({ ...context, allowNetwork: false, stored }, "https://chatgpt.com/backend-api", [], async () => {
		throw new Error("offline refresh must not fetch");
	});
	assert.equal(offline.at(-1).id, "gpt-6-astra");
});

test("real extension registration mirrors the primary stored Astra model", async () => {
	const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
	const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
	const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
	const eventBus = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
	const runtime = loader.createExtensionRuntime();
	const extensionPath = new URL("./index.ts", import.meta.url).pathname;
	const loaded = await loader.loadExtensions([extensionPath], process.cwd(), eventBus.createEventBus(), runtime);
	assert.deepEqual(loaded.errors, []);
	const registration = runtime.pendingProviderRegistrations.find((entry) => entry.name === "openai-codex-second");
	assert(registration);
	assert.equal(typeof registration.config.refreshModels, "function");
	assert(registration.config.models.some((model) => model.id === "gpt-6-astra"));
});
