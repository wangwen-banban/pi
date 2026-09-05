import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const sourcePath = new URL("./index.ts", import.meta.url);
const source = readFileSync(sourcePath, "utf8");

assert.match(source, /@earendil-works\/pi-ai\/providers\/all/);
assert.match(source, /openai-codex-second/);
assert.match(source, /bridgeSecondaryCodexStream/);
assert.doesNotMatch(source, /PI_ROOT|PI_AI_ROOT|\/Users\/[^/]+\/\.nvm/);
assert.doesNotMatch(source, /node_modules\/@earendil-works\/pi-ai\/dist/);

const result = spawnSync(
  "pi",
  [
    "--provider",
    "openai-codex-second",
    "--model",
    "gpt-6-astra",
    "--no-session",
    "-p",
    "Reply exactly SECOND-ASTRA-LOAD-OK",
  ],
  { encoding: "utf8", timeout: 120_000 },
);
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;

assert.notEqual(result.error?.code, "ENOENT", "pi executable must be available");
assert.doesNotMatch(output, /Failed to load extension/);
assert.doesNotMatch(output, /Cannot find module/);
assert.doesNotMatch(output, /Unknown model|Model .* not found/i);
assert.ok(
  output.includes("SECOND-ASTRA-LOAD-OK") ||
    output.includes("No API key found for openai-codex-second"),
  `secondary provider did not register correctly:\n${output.slice(0, 500)}`,
);

console.log("✓ secondary Codex provider loads through pi's virtual modules");
console.log("✓ model registration is available without fixed npm/nvm paths");
