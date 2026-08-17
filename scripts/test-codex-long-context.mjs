import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codexConfigPath = process.env.CODEX_CONFIG_PATH || join(homedir(), ".codex", "config.toml");
const modelsPath = join(repoRoot, "models.json");
const subagentsPath = join(repoRoot, "subagents.json");

const codexConfig = readFileSync(codexConfigPath, "utf8");
const firstSection = codexConfig.search(/^\s*\[/m);
const topLevel = firstSection < 0 ? codexConfig : codexConfig.slice(0, firstSection);
const expectedCodexSettings = {
  model: '"gpt-5.6-sol"',
  model_context_window: "1000000",
  model_auto_compact_token_limit: "900000",
  model_auto_compact_token_limit_scope: '"total"',
};

for (const [key, value] of Object.entries(expectedCodexSettings)) {
  const expression = new RegExp(`^\\s*${key}\\s*=\\s*${value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*$`, "gm");
  assert.equal([...codexConfig.matchAll(expression)].length, 1, `${key} must occur exactly once`);
  assert.match(topLevel, expression, `${key} must be a top-level setting before the first section`);
}

if (process.platform !== "win32") {
  assert.equal(statSync(codexConfigPath).mode & 0o777, 0o600, "Codex config must remain mode 0600");
}

const models = JSON.parse(readFileSync(modelsPath, "utf8"));
const codexProviders = ["openai-codex", "openai-codex-second"];
const gpt56Models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
for (const provider of codexProviders) {
  const overrides = models.providers?.[provider]?.modelOverrides;
  assert.ok(overrides, `${provider} modelOverrides are required`);
  for (const model of gpt56Models) {
    assert.equal(overrides[model]?.contextWindow, 1_000_000, `${provider}/${model} must use the Codex 1M window`);
  }
}

const directOverrides = models.providers?.openai?.modelOverrides;
assert.ok(directOverrides, "direct OpenAI API modelOverrides are required");
for (const model of gpt56Models) {
  assert.equal(directOverrides[model]?.contextWindow, 1_050_000, `openai/${model} must use the documented API window`);
}

const subagents = JSON.parse(readFileSync(subagentsPath, "utf8"));
assert.equal(subagents.router?.model, "openai-codex/gpt-5.6-luna");
assert.equal(subagents.modelProfiles?.models?.["openai-codex/gpt-5.6-sol"]?.tier, "S");
assert.equal(subagents.modelProfiles?.models?.["openai-codex/gpt-5.6-terra"]?.tier, "B");
assert.equal(subagents.modelProfiles?.models?.["openai-codex/gpt-5.6-luna"]?.tier, "C");
const routeModels = Object.values(subagents.routes ?? {}).flatMap((route) => route.models ?? []);
assert.equal(routeModels.some((model) => /openai-codex\/gpt-5\.(4(?:-mini)?|5)$/.test(model)), false, "routes must use GPT-5.6 instead of legacy GPT-5.4/GPT-5.5 fallbacks");
assert.ok(routeModels.includes("openai-codex/gpt-5.6-luna"));
assert.ok(routeModels.includes("openai-codex/gpt-5.6-terra"));
assert.ok(routeModels.includes("openai-codex/gpt-5.6-sol"));

console.log("Codex long-context config: 1M window, 900K compaction, mode 0600");
console.log("Pi long-context overrides: primary OAuth, second OAuth, and direct API");
console.log("Smart-subagent routes: GPT-5.6 Luna/Terra/Sol");
