/**
 * BTW engine test — exercises session.ts against a real model.
 * Validates: snapshot rendering, context inheritance, read-only tools,
 * multi-turn memory, and that nothing is persisted.
 *
 * Run: node --experimental-strip-types test-engine.mjs
 */
import { createBtwSession, renderParentSnapshot, resolveInstalledPiRoot, BTW_READONLY_TOOLS } from "./session.ts";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const PI_ROOT = resolveInstalledPiRoot();
const { ModelRegistry } = await import(pathToFileURL(join(PI_ROOT, "dist", "index.js")).href);
const { ModelRuntime } = await import(pathToFileURL(join(PI_ROOT, "dist", "core", "model-runtime.js")).href);

const sessionSource = readFileSync(new URL("./session.ts", import.meta.url), "utf8");
if (/\/Users\/[^/]+\/\.nvm|\/opt\/homebrew\/lib\/node_modules/.test(sessionSource)) {
  throw new Error("BTW session loader must not hardcode a user-specific global Pi path");
}

const cwd = "/tmp/btw-engine-test";
mkdirSync(cwd, { recursive: true });
writeFileSync(cwd + "/config.yaml", "retries: 7\ntimeout_ms: 4200\n");

const AGENT_DIR = homedir() + "/.pi/agent";
const runtime = await ModelRuntime.create({
  authPath: AGENT_DIR + "/auth.json",
  modelsPath: AGENT_DIR + "/models.json",
});
const registry = new ModelRegistry(runtime);
const model = registry.find("opencode-go", "deepseek-v4-flash")
  ?? registry.find("openai-codex", "gpt-5.6-luna")
  ?? registry.getAvailable()[0];
if (!model || !registry.hasConfiguredAuth(model)) {
  console.error("no configured BTW live-smoke model available");
  process.exit(1);
}
console.log(`live model: ${model.provider}/${model.id}`);

let fails = 0;
const check = (label, cond, extra = "") => {
  console.log(`  ${cond ? "✓" : "✗"} ${label}${extra ? "  " + extra : ""}`);
  if (!cond) fails++;
};

// ---------------------------------------------------------------------------
console.log("\n=== 1. renderParentSnapshot ===");

const fakeCtx = (entries, name) => ({
  cwd,
  model,
  modelRegistry: registry,
  sessionManager: { getBranch: () => entries, getSessionName: () => name },
});

const msg = (role, text) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });

const snapEmpty = renderParentSnapshot(fakeCtx([], undefined));
check("empty branch -> text null", snapEmpty.text === null);

const snap = renderParentSnapshot(
  fakeCtx([msg("user", "refactor billing.ts"), msg("assistant", "Done, split computeTax()"), { type: "other" }], "main-work"),
);
check("picks up user + assistant", /refactor billing\.ts/.test(snap.text) && /computeTax/.test(snap.text));
check("skips non-message entries", !/other/.test(snap.text ?? ""));
check("carries session name", snap.name === "main-work");

const bigSnap = renderParentSnapshot(fakeCtx([msg("user", "x".repeat(5000))], undefined), 500);
check("respects char budget", (bigSnap.text?.length ?? 0) < 900, `len=${bigSnap.text?.length}`);
check("marks truncation", /earlier turns omitted/.test(bigSnap.text ?? ""));

const compactSnap = renderParentSnapshot({
  sessionManager: {
    getSessionName: () => "compacted",
    buildContextEntries: () => [
      { type: "compaction", summary: "Earlier architecture and constraints" },
      msg("user", "continue from summary"),
      { type: "message", message: { role: "assistant", content: [
        { type: "thinking", thinking: "checking constraints" },
        { type: "toolCall", name: "read", arguments: { path: "x.ts" } },
        { type: "text", text: "ready" },
      ] } },
      { type: "message", message: { role: "toolResult", content: [{ type: "text", text: "file contents" }] } },
    ],
  },
});
check("uses compaction-aware context entries", /历史摘要.*Earlier architecture/s.test(compactSnap.text ?? ""));
check("includes assistant thinking/tool calls", /checking constraints/.test(compactSnap.text ?? "") && /read\(/.test(compactSnap.text ?? ""));
check("includes tool results", /file contents/.test(compactSnap.text ?? ""));

const panelSource = readFileSync(new URL("./panel.ts", import.meta.url), "utf8");
check("panel Enter can steer while streaming", /session\.steer\(text\)/.test(panelSource));
check("panel Tab can queue follow-up", /session\.followUp\(text\)/.test(panelSource) && /Key\.tab/.test(panelSource));
check("panel renders queue counts", /case "queue_update"/.test(panelSource) && /queuedFollow/.test(panelSource));
check("panel uses injected PgUp/PgDn keybindings", /resolveBtwPagingInput\(data, keybindings\)/.test(panelSource));
check("panel preserves history during streaming", /layoutBtwViewport\(scroll, body\.length, maxBody\)/.test(panelSource));
check("panel documents macOS Fn paging", /Fn\+↑\/↓ \(PgUp\/PgDn\)/.test(panelSource));

// ---------------------------------------------------------------------------
console.log("\n=== 2. createBtwSession (real model, in-memory) ===");

const SNAPSHOT =
  "User: I'm working on the parser in lexer.ts and asked about the tokenize() function.\n\n" +
  "Assistant: tokenize() splits input into tokens using a state machine.";

let handle;
try {
  handle = await createBtwSession({ ctx: fakeCtx([], "main-work"), snapshot: SNAPSHOT });
} catch (e) {
  console.log(`  ✗ createBtwSession threw: ${e?.message}`);
  process.exit(1);
}
const s = handle.session;
const latestAssistant = () => {
  const assistant = [...(s.messages ?? [])].reverse().find(m => m?.role === "assistant");
  if (assistant?.errorMessage) {
    console.log(`    provider error: ${assistant.errorMessage}`);
  }
  return (assistant?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
};
check("session created", !!s);
check("inherited runtime -> model resolved", !!s.model?.id, s.model?.id);
check("not persisted", s.sessionManager?.isPersisted?.() === false);
check("no session file", !s.sessionManager?.getSessionFile?.());
check("read-only tool set declared", BTW_READONLY_TOOLS.join(",") === "read,grep,find,ls");

// ---------------------------------------------------------------------------
console.log("\n=== 3. turn 1: must use a tool ===");
await s.prompt("Read config.yaml in the cwd and tell me the retries value. Reply with just the number.");
const t1 = latestAssistant();
console.log("    reply:", JSON.stringify(t1.slice(0, 120)));
check("tool actually used (found 7)", /\b7\b/.test(t1));

// ---------------------------------------------------------------------------
console.log("\n=== 4. turn 2: multi-turn memory + inherited context ===");
await s.prompt("What was the timeout value in that same file, and which function did I ask about in the main thread?");
const t2 = latestAssistant();
console.log("    reply:", JSON.stringify(t2.slice(0, 220)));
check("multi-turn works (found 4200)", /4200/.test(t2));
check("inherited main-thread context visible", /tokenize/i.test(t2));

// ---------------------------------------------------------------------------
console.log("\n=== 5. mutation is structurally impossible (behavioural) ===");
const victim = cwd + "/should-not-exist.txt";
await s.prompt(
  `Create a file at ${victim} containing the word HACKED. If you have no tool capable of writing files, say exactly NO_WRITE_TOOL.`,
);
const t3 = latestAssistant();
console.log("    reply:", JSON.stringify(t3.slice(0, 200)));
check("file was NOT created", !existsSync(victim));
// Inspect every tool the model actually invoked across the whole session.
const invoked = new Set();
for (const m of s.messages ?? []) {
  for (const c of m?.content ?? []) if (c.type === "toolCall") invoked.add(c.name);
}
console.log("    tools actually invoked:", [...invoked].join(", ") || "(none)");
check("never invoked edit", !invoked.has("edit"));
check("never invoked write", !invoked.has("write"));
check("never invoked bash", !invoked.has("bash"));
check("did invoke a read-only tool", [...invoked].some(n => BTW_READONLY_TOOLS.includes(n)));

// ---------------------------------------------------------------------------
console.log("\n=== 6. nothing on disk ===");
const dir = s.sessionManager?.getSessionDir?.();
const before = existsSync(dir ?? "") ? readdirSync(dir).length : 0;
await handle.dispose();
const after = existsSync(dir ?? "") ? readdirSync(dir).length : 0;
check("session dir unchanged by BTW", before === after, `${before} -> ${after}`);

console.log(`\n${fails === 0 ? "ALL PASS ✓" : `${fails} FAILURE(S) ✗`}`);
process.exit(fails === 0 ? 0 : 1);
