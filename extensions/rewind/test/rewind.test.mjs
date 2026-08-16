import assert from "node:assert/strict";
import test from "node:test";
import rewind, { MARKER_TYPE, getRewindChoices, makeMarker, markerRestoreText } from "../index.ts";

const user = (id, parentId, text) => ({
  type: "message", id, parentId,
  message: { role: "user", content: text },
});
const assistant = (id, parentId, text = "ok") => ({
  type: "message", id, parentId,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

function setup({ entries, selectedIndex = 0, sessionFile = "/tmp/test-rewind.jsonl", idle = true, pending = false, cancelSwitch = false, root = false } = {}) {
  const state = { branch: [...entries], leafId: entries.at(-1)?.id ?? null };
  const calls = { select: 0, navigate: [], append: [], switches: [], oldEditor: [], replacementEditor: [], notices: [] };
  const commandBox = new Map();
  const events = new Map();
  let activeCtx;
  const pi = {
    on(name, handler) { events.set(name, handler); },
    registerCommand(name, command) { commandBox.set(name, command); },
    appendEntry(type, data) {
      assert.equal(type, MARKER_TYPE);
      const marker = { type: "custom", id: "marker", parentId: state.leafId, data, customType: type };
      calls.append.push(marker);
      state.branch.push(marker);
      state.leafId = marker.id;
    },
  };
  rewind(pi);
  const command = commandBox.get("rewind");
  const oldUi = {
    select: async (_title, options) => {
      calls.select++;
      return options[selectedIndex];
    },
    setEditorText(text) { calls.oldEditor.push(text); },
    notify(message, type) { calls.notices.push({ message, type }); },
  };
  const replacementUi = {
    setEditorText(text) { calls.replacementEditor.push(text); },
    notify(message, type) { calls.notices.push({ message, type }); },
  };
  const context = {
    ui: oldUi,
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    hasPendingMessages: () => pending,
    sessionManager: {
      getBranch: () => [...state.branch],
      getEntry: (id) => state.branch.find((entry) => entry.id === id) ?? entries.find((entry) => entry.id === id),
      getLeafId: () => state.leafId,
      getSessionFile: () => sessionFile,
    },
    async navigateTree(id) {
      calls.navigate.push(id);
      const target = entries.find((entry) => entry.id === id);
      if (!target) throw new Error("missing target");
      state.branch = target.parentId === null ? [] : entries.slice(0, entries.findIndex((entry) => entry.id === target.parentId) + 1);
      state.leafId = target.parentId;
      return { cancelled: false };
    },
    async switchSession(file, options) {
      calls.switches.push(file);
      if (cancelSwitch) return { cancelled: true };
      activeCtx = { ...context, ui: replacementUi };
      await options.withSession(activeCtx);
      return { cancelled: false };
    },
  };
  activeCtx = context;
  return { command, context, calls, state, events, get activeCtx() { return activeCtx; } };
}

const entries = [
  user("u1", null, "first prompt"),
  assistant("a1", "u1"),
  user("u2", "a1", "same duplicate prompt with enough text to show selector handling"),
  assistant("a2", "u2"),
  user("u3", "a2", "same duplicate prompt with enough text to show selector handling"),
  assistant("a3", "u3"),
];

test("selector is current-branch-only, newest-first, and duplicate labels map by id", () => {
  const choices = getRewindChoices(entries);
  assert.deepEqual(choices.map((x) => x.entryId), ["u3", "u2", "u1"]);
  assert.notEqual(choices[0].option, choices[1].option);
  assert.match(choices[0].option, /u3/);
  assert.equal(choices[0].text, entries[4].message.content);
  // The helper never scans session history itself; callers pass only getBranch().
  assert.deepEqual(getRewindChoices([entries[0], entries[1]]).map((x) => x.entryId), ["u1"]);
});

test("normal rewind navigates, appends opaque marker, reopens same file, and restores replacement editor", async () => {
  const run = setup({ entries, selectedIndex: 1 }); // u2, not u3
  await run.command.handler("", run.context);
  assert.deepEqual(run.calls.navigate, ["u2"]);
  assert.deepEqual(run.calls.switches, ["/tmp/test-rewind.jsonl"]);
  assert.equal(run.calls.oldEditor.length, 0, "stale context must not restore editor");
  assert.deepEqual(run.calls.replacementEditor, [entries[2].message.content]);
  assert.equal(run.calls.append.length, 1);
  assert.equal(run.calls.append[0].parentId, "a1");
  assert.deepEqual(run.calls.append[0].data, makeMarker("u2", "a3", "a1", run.calls.append[0].data.createdAt));
  assert.equal("text" in run.calls.append[0].data, false);
  assert.deepEqual(run.state.branch.map((entry) => entry.id), ["u1", "a1", "marker"]);
  assert.equal(run.state.leafId, "marker", "reopened file lands on durable marker leaf");
  assert.equal(markerRestoreText("marker", (id) => [...run.state.branch, ...entries].find((entry) => entry.id === id)), entries[2].message.content);
  await run.events.get("session_start")({}, run.activeCtx);
  assert.equal(run.calls.replacementEditor.at(-1), entries[2].message.content, "marker can restore after a later reopen");
});

test("root rewind uses null target parent and works for ephemeral sessions", async () => {
  const rootEntries = [user("root", null, "root text"), assistant("root-a", "root")];
  const run = setup({ entries: rootEntries, sessionFile: null });
  await run.command.handler("", run.context);
  assert.equal(run.calls.append[0].data.targetParentId, null);
  assert.equal(run.calls.append[0].parentId, null);
  assert.deepEqual(run.calls.oldEditor, ["root text"]);
  assert.equal(run.calls.switches.length, 0);
  assert.deepEqual(run.state.branch.map((entry) => entry.id), ["marker"]);
});

test("cancel is mutation-free", async () => {
  const run = setup({ entries });
  run.context.ui.select = async () => undefined;
  await run.command.handler("", run.context);
  assert.equal(run.calls.select, 0);
  assert.equal(run.calls.navigate.length, 0);
  assert.equal(run.calls.append.length, 0);
  assert.equal(run.calls.switches.length, 0);
});

test("empty branch, argument, busy, and pending states are rejected safely", async () => {
  for (const variant of [
    { entries: [], expected: /No user turns/ },
    { entries, idle: false, expected: /busy/ },
    { entries, pending: true, expected: /busy/ },
  ]) {
    const run = setup(variant);
    await run.command.handler("", run.context);
    assert.equal(run.calls.select, 0);
    assert.equal(run.calls.append.length, 0);
    assert.match(run.calls.notices.at(-1).message, variant.expected);
  }
  const run = setup({ entries });
  await run.command.handler("unexpected", run.context);
  assert.equal(run.calls.select, 0);
  assert.equal(run.calls.append.length, 0);
});

test("cancelled same-file replacement leaves active rewind state and safely uses old context", async () => {
  const run = setup({ entries, selectedIndex: 2, cancelSwitch: true });
  await run.command.handler("", run.context);
  assert.equal(run.calls.append.length, 1);
  assert.deepEqual(run.calls.oldEditor, ["first prompt"]);
  assert.equal(run.calls.replacementEditor.length, 0);
  assert.match(run.calls.notices.at(-1).message, /cancelled/);
});
