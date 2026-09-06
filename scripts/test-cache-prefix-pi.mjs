import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { contextSnapshotResult, registerContextSnapshot } from "../extensions/shared/context-snapshot.ts";

const globalRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(globalRoot, "@earendil-works", "pi-coding-agent");
const { SessionManager } = await import(pathToFileURL(join(piRoot, "dist/core/session-manager.js")).href);
const TYPE = "test:context:v1";
const snapshot = (sm, text = "A") => contextSnapshotResult(sm, TYPE, text).message;
const append = (sm, text = "A") => sm.appendCustomMessageEntry(TYPE, text, false);
const user = (sm, text = "next") => sm.appendMessage({ role: "user", content: text, timestamp: Date.now() });

test("Pi: custom snapshot becomes model-visible and deduplicates", () => {
 const sm = SessionManager.inMemory();
 assert.equal(snapshot(sm).content, "A");
 append(sm);
 assert.equal(snapshot(sm), undefined);
 assert.ok(sm.buildSessionContext().messages.some(m => m.role === "custom" && m.customType === TYPE));
});
test("Pi: state-only markers never suppress a visible snapshot", () => {
 const sm = SessionManager.inMemory();
 sm.appendCustomEntry(TYPE, { content: "A" });
 assert.equal(snapshot(sm).content, "A");
});
test("Pi: latest snapshot wins across A -> B -> A", () => {
 const sm = SessionManager.inMemory();
 append(sm, "A"); append(sm, "B");
 assert.equal(snapshot(sm, "A").content, "A");
});
test("Pi: off-branch snapshots do not influence deduplication", () => {
 const sm = SessionManager.inMemory();
 const original = append(sm, "A");
 user(sm); append(sm, "B");
 sm.branch(original);
 assert.equal(snapshot(sm, "A"), undefined);
 assert.equal(snapshot(sm, "B").content, "B");
});
test("Pi: reset leaf requires a fresh snapshot", () => {
 const sm = SessionManager.inMemory(); append(sm); sm.resetLeaf();
 assert.equal(snapshot(sm).content, "A");
});
test("Pi: compaction dropping the snapshot restores current state", () => {
 const sm = SessionManager.inMemory();
 append(sm);
 const kept = user(sm);
 sm.appendCompaction("Older state summarized", kept, 10000);
 assert.equal(snapshot(sm).content, "A");
});
test("Pi: compaction retaining the snapshot does not duplicate it", () => {
 const sm = SessionManager.inMemory(); user(sm);
 const kept = append(sm);
 sm.appendCompaction("Older messages summarized", kept, 10000);
 assert.equal(snapshot(sm), undefined);
});
test("Pi: compaction hook appends once and never requests a model turn", () => {
 const sm = SessionManager.inMemory(); append(sm);
 sm.appendCompaction("Older state summarized", user(sm), 10000);
 const handlers = new Map(); const sent = [];
 registerContextSnapshot({ on: (name, fn) => handlers.set(name, fn),
  sendMessage: (message, options) => {
   sent.push(options);
   sm.appendCustomMessageEntry(message.customType, message.content, message.display);
  },
 }, TYPE, () => "A");
 handlers.get("session_compact")({}, { sessionManager: sm });
 assert.deepEqual(sent, [{ triggerTurn: false }]);
 assert.equal(handlers.get("before_agent_start")({}, { sessionManager: sm }).message, undefined);
});
