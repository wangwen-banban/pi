import { persistBtwSession, resolveInstalledPiRoot } from "./session.ts";
import { readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const { SessionManager } = await import(pathToFileURL(join(resolveInstalledPiRoot(), "dist", "index.js")).href);
const cwd = "/tmp/btw-persist-test";
mkdirSync(cwd, { recursive: true });

const fake = {
  model: { provider: "test-provider", id: "test-model" },
  thinkingLevel: "high",
  messages: [
    { role: "user", content: [{ type: "text", text: "first BTW question" }], timestamp: Date.now() },
    { role: "assistant", content: [{ type: "text", text: "first answer" }], api: "x", provider: "test-provider", model: "test-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() },
    { role: "user", content: [{ type: "text", text: "follow up" }], timestamp: Date.now() },
    { role: "assistant", content: [{ type: "text", text: "second answer" }], api: "x", provider: "test-provider", model: "test-model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() },
    // Error turns must not be persisted.
    { role: "assistant", content: [], stopReason: "error", errorMessage: "ignore me", timestamp: Date.now() },
  ],
};

let path;
try {
  path = await persistBtwSession(fake, { cwd, name: "BTW persistence test" });
  const raw = readFileSync(path, "utf8");
  const lines = raw.trim().split("\n").map(JSON.parse);
  const messageEntries = lines.filter(e => e.type === "message");
  const sessionInfo = lines.find(e => e.type === "session_info");
  const modelChange = lines.find(e => e.type === "model_change");
  const thinking = lines.find(e => e.type === "thinking_level_change");

  const checks = [
    ["file created", !!path],
    ["four visible messages persisted", messageEntries.length === 4],
    ["error assistant omitted", !raw.includes("ignore me")],
    ["name persisted", sessionInfo?.name === "BTW persistence test"],
    ["model persisted", modelChange?.provider === "test-provider" && modelChange?.modelId === "test-model"],
    ["thinking level persisted", thinking?.thinkingLevel === "high"],
    ["no hidden boundary", !raw.includes("SIDE CONVERSATION BOUNDARY")],
  ];

  for (const [name, ok] of checks) console.log(`${ok ? "✓" : "✗"} ${name}`);
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1;
} finally {
  if (path) rmSync(path, { force: true });
  rmSync(cwd, { recursive: true, force: true });
}
