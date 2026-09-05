import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const loader = await import(pathToFileURL(join(piRoot, "dist/core/extensions/loader.js")).href);
const eventBus = await import(pathToFileURL(join(piRoot, "dist/core/event-bus.js")).href);
const runtime = loader.createExtensionRuntime();
const extensionPath = new URL("./index.ts", import.meta.url).pathname;
const loaded = await loader.loadExtensions([extensionPath], process.cwd(), eventBus.createEventBus(), runtime);

assert.deepEqual(loaded.errors, []);
const registrations = new Map(runtime.pendingProviderRegistrations.map((entry) => [entry.name, entry.config]));

test("Cambricon providers use the live gateway model ids", () => {
	const claude = registrations.get("claude-cambricon");
	assert(claude);
	assert.deepEqual(claude.models.map((model) => model.id), ["k3"]);
	assert.equal(claude.models[0].contextWindow, 1_000_000);

	const codex = registrations.get("cambricon-codex");
	assert(codex);
	assert.deepEqual(codex.models.map((model) => model.id), [
		"gpt-5.3-codex-spark",
		"gpt-5.6-luna",
		"gpt-5.6-terra",
		"gpt-5.6-sol",
		"gpt-6-astra",
	]);
	assert.equal(codex.models.find((model) => model.id === "gpt-5.3-codex-spark").contextWindow, 128_000);
	assert.equal(codex.models.find((model) => model.id === "gpt-6-astra").contextWindow, 1_000_000);
	assert.equal(codex.models.find((model) => model.id === "gpt-5.6-sol").thinkingLevelMap.max, "max");
});

test("Claude stream maps the display model to the configured request model", () => {
	const source = readFileSync(extensionPath, "utf8");
	assert.match(source, /requestModel = \{ \.\.\.model, id: cambricon\.requestModelId! \}/);
	assert.match(source, /provider\.streamSimple\(requestModel, filteredContext/);
	assert.doesNotMatch(source, /k3-anthropic/);
	assert.doesNotMatch(source, /gpt-5\.6-sol-(?:high|medium|max)/);
});
