import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const source = readFileSync(extensionPath, "utf8");
assert.match(source, /run_background_task/);
assert.match(source, /update_task_plan/);
assert.match(source, /triggerTurn: true/);
assert.match(source, /deliverAs: "followUp"/);
assert.equal((source.match(/executionMode: "sequential"/g) ?? []).length, 3);
assert.match(source, /background-task:\$\{event\}/);
assert.match(source, /run\.status === "completed" \? "completed"/);
assert.match(source, /current user's goal, not permanent history/);
assert.match(source, /omit terminal or obsolete tasks/);
assert.doesNotMatch(source, /\/opt\/homebrew\/lib\/node_modules|\/Users\/[^/]+\/\.nvm/);

const result = spawnSync(
	"pi",
	["--no-extensions", "-e", extensionPath, "--list-models"],
	{ encoding: "utf8", timeout: 120_000 },
);
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
assert.equal(result.error, undefined);
assert.equal(result.status, 0, output.slice(0, 1000));
assert.doesNotMatch(output, /Failed to load extension|Cannot find module/);
console.log("✓ background-tasks loads through Pi virtual modules");
console.log("✓ managed task tools register without fixed installation paths");
