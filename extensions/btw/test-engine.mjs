/**
 * BTW engine test — exercises session.ts against a real model.
 * Validates: snapshot rendering, context inheritance, read-only tools,
 * multi-turn memory, and that nothing is persisted.
 *
 * Run: node --experimental-strip-types test-engine.mjs
 */
import { createBtwSession, renderParentSnapshot, BTW_READONLY_TOOLS } from "./session.ts";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

const PI = "/Users/wenwang/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
const { ModelRegistry } = await import(PI);
const { ModelRuntime } = await import(
  "/Users/wenwang/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js"
);

const cwd = "/tmp/btw-engine-test";
mkdirSync(cwd, { recursive: true });
writeFileSync(cwd + "/config.yaml", "retries: 7\ntimeout_ms: 4200\n");

const AGENT_DIR = homedir() + "/.pi/agent";
const runtime = await ModelRuntime.create({
  authPath: AGENT_DIR + "/auth.json",
  modelsPath: AGENT_DIR + "/models.json",
});
const registry = new ModelRegistry(runtime);
const model = registry.getAvailable()[0];
if (!model) { console.error("no model available"); process.exit(1); }

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
check("session created", !!s);
check("inherited runtime -> model resolved", !!s.model?.id, s.model?.id);
check("not persisted", s.sessionManager?.isPersisted?.() === false);
check("no session file", !s.sessionManager?.getSessionFile?.());
check("read-only tool set declared", BTW_READONLY_TOOLS.join(",") === "read,grep,find,ls");

// ---------------------------------------------------------------------------
console.log("\n=== 3. turn 1: must use a tool ===");
await s.prompt("Read config.yaml in the cwd and tell me the retries value. Reply with just the number.");
const t1 = (s.messages.at(-1)?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
console.log("    reply:", JSON.stringify(t1.slice(0, 120)));
check("tool actually used (found 7)", /\b7\b/.test(t1));

// ---------------------------------------------------------------------------
console.log("\n=== 4. turn 2: multi-turn memory + inherited context ===");
await s.prompt("What was the timeout value in that same file, and which function did I ask about in the main thread?");
const t2 = (s.messages.at(-1)?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
console.log("    reply:", JSON.stringify(t2.slice(0, 220)));
check("multi-turn works (found 4200)", /4200/.test(t2));
check("inherited main-thread context visible", /tokenize/i.test(t2));

// ---------------------------------------------------------------------------
console.log("\n=== 5. mutation is structurally impossible (behavioural) ===");
const victim = cwd + "/should-not-exist.txt";
await s.prompt(
  `Create a file at ${victim} containing the word HACKED. If you have no tool capable of writing files, say exactly NO_WRITE_TOOL.`,
);
const t3 = (s.messages.at(-1)?.content ?? []).filter(c => c.type === "text").map(c => c.text).join("");
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
