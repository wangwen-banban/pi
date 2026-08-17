// test-activity-controller.mjs — node --test suite for activity-controller.js
// Uses fake WorkspaceFiles, a fake scheduler and host, and a mutable clock.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, sessionsDir, runtimesDir, runtimeDir, acksDir, ackPath,
} from './activity-schema.js';
import { createActivityController, capTerminalPendingRequests, MAX_TERMINAL_PENDING_REQUESTS } from './activity-controller.js';

// ---- fake WorkspaceFiles ---------------------------------------------------

function enoent(path) {
  const err = new Error(`ENOENT: no such file or directory '${path}'`);
  err.code = 'ENOENT';
  return err;
}

function createFakeFiles(files = {}, options = {}) {
  const callLog = [];
  const { hooks = {} } = options;
  const stats = { maxConcurrentSessionsList: 0, sessionsListCalls: 0 };
  let concurrentSessionsList = 0;

  return {
    callLog,
    stats,
    async listFiles(path) {
      callLog.push({ method: 'listFiles', path });
      if (path === sessionsDir()) {
        concurrentSessionsList += 1;
        stats.sessionsListCalls += 1;
        stats.maxConcurrentSessionsList = Math.max(stats.maxConcurrentSessionsList, concurrentSessionsList);
        try {
          if (hooks.gateSessions) await hooks.gateSessions(path);
        } finally {
          concurrentSessionsList -= 1;
        }
      }
      if (hooks.listFiles) await hooks.listFiles(path);
      const content = files[path];
      if (content === undefined) throw enoent(path);
      if (content && Array.isArray(content.entries)) {
        return { path, entries: content.entries, truncated: false };
      }
      throw new Error(`listFiles: ${path} is not a directory`);
    },
    async readFile(path) {
      callLog.push({ method: 'readFile', path });
      if (hooks.readFile) await hooks.readFile(path);
      const content = files[path];
      if (content === undefined) throw enoent(path);
      if (typeof content === 'string') {
        return { path, content, encoding: 'utf8', size: content.length, truncated: false, binary: false };
      }
      throw new Error(`readFile: ${path} is not a file`);
    },
    async writeFile(path, content, options = {}) {
      callLog.push({ method: 'writeFile', path, content });
      if (hooks.writeFile) await hooks.writeFile(path);
      if (files[path] !== undefined && !options.overwrite) throw new Error(`File exists: ${path}`);
      files[path] = content;
      return { path, size: content.length, created: true };
    },
    async moveFile(fromPath, toPath, options = {}) {
      callLog.push({ method: 'moveFile', fromPath, toPath });
      if (hooks.moveFile) await hooks.moveFile(fromPath, toPath);
      if (files[fromPath] === undefined) throw enoent(fromPath);
      if (files[toPath] !== undefined && !options.overwrite) throw new Error(`File exists: ${toPath}`);
      files[toPath] = files[fromPath];
      delete files[fromPath];
      return { fromPath, toPath };
    },
    async deleteFile(path) {
      callLog.push({ method: 'deleteFile', path });
      if (hooks.deleteFile) await hooks.deleteFile(path);
      const existed = files[path] !== undefined;
      delete files[path];
      return { path, existed };
    },
  };
}

// ---- fake scheduler / host / clock -----------------------------------------

function createFakeScheduler() {
  const calls = { intervals: 0, cleared: 0, ms: [], intervalFns: [], handles: [] };
  let seq = 1;
  return {
    calls,
    setInterval(fn, ms) {
      calls.intervals += 1;
      calls.ms.push(ms);
      calls.intervalFns.push(fn);
      const handle = seq++;
      calls.handles.push(handle);
      return handle;
    },
    clearInterval(handle) {
      calls.cleared += 1;
      calls.handles = calls.handles.filter((h) => h !== handle);
    },
    fireLastInterval() {
      const fn = calls.intervalFns[calls.intervalFns.length - 1];
      if (fn) fn();
    },
  };
}

function createFakeHost() {
  return { renders: 0, requestRender() { this.renders += 1; } };
}

// ---- backend-shaped file builders ------------------------------------------

function mkRuntimeJson(sessionId, runtimeId, overrides = {}) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    source: 'smart-subagents',
    sessionId,
    runtimeId,
    generation: 0,
    controlToken: `token-${runtimeId}`,
    state: 'active',
    startedAt: 1000,
    updatedAt: 2000,
    heartbeatAt: 2000,
    jobs: { total: 0, active: 0 },
    ...overrides,
  });
}

function mkJobJson(id, status, overrides = {}) {
  return {
    id,
    name: `Job ${id}`,
    status,
    stopping: false,
    createdAt: 100,
    startedAt: 200,
    progress: [],
    changedFiles: [],
    ...overrides,
  };
}

function mkAgentsJson(sessionId, runtimeId, jobs = [], overrides = {}) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    generation: 0,
    updatedAt: 2000,
    jobs,
    ...overrides,
  });
}

function mkAckJson(sessionId, runtimeId, requestId, action, overrides = {}) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    generation: 0,
    requestId,
    action,
    accepted: true,
    reason: 'stopped',
    respondedAt: Date.now(),
    ...overrides,
  });
}

function listDir(...names) {
  return { entries: names.map((name) => ({ name, path: name, type: 'directory' })) };
}

function listFiles(...names) {
  return { entries: names.map((name) => ({ name, path: name, type: 'file' })) };
}

function smartSessionFiles(opts = {}) {
  const sessionId = opts.sessionId ?? 'sess1';
  const runtimeId = opts.runtimeId ?? 'rt1';
  const generation = opts.generation ?? 0;
  const heartbeatAt = opts.heartbeatAt ?? 2000;
  const jobs = opts.jobs ?? [mkJobJson('j1', 'running')];
  const runtimeOverrides = { generation, heartbeatAt, ...(opts.runtimeOverrides || {}) };
  const files = {
    [sessionsDir()]: listDir(sessionId),
    [runtimesDir(sessionId)]: listDir(runtimeId),
    [`${runtimeDir(sessionId, runtimeId)}/runtime.json`]: mkRuntimeJson(sessionId, runtimeId, runtimeOverrides),
    [`${runtimeDir(sessionId, runtimeId)}/agents.json`]: mkAgentsJson(sessionId, runtimeId, jobs, { generation }),
  };
  return { files, sessionId, runtimeId, generation };
}

function publishedEnvelope(files) {
  for (const [path, content] of Object.entries(files)) {
    if (path.includes('/requests/') && path.endsWith('.json')) {
      return { path, envelope: JSON.parse(content) };
    }
  }
  return null;
}

// ---- tests -----------------------------------------------------------------

describe('controller — scheduling', () => {
  it('refreshes immediately on start and installs a 1s timer', async () => {
    const { files, sessionId, runtimeId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    assert.equal(fakeFiles.stats.sessionsListCalls, 1); // immediate refresh
    assert.equal(scheduler.calls.intervals, 1);
    assert.equal(scheduler.calls.ms[0], 1000);
    assert.ok(host.renders >= 1);
    assert.ok(c.getView(null).sessions.some((s) => s.sessionId === sessionId));
    assert.ok(c.getView(null).sessions[0].stop.runtimeId === runtimeId);
  });

  it('timer fires every 1s and each tick refreshes (elapsed advances locally)', async () => {
    const { files } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    let now = 5000;
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => now });

    await c.start();
    const before = c.getView(null).sessions[0].jobs[0].elapsed;
    now += 1000;                 // one local second passes
    scheduler.fireLastInterval();
    await c.refreshNow();        // await the queued/in-flight tick
    const after = c.getView(null).sessions[0].jobs[0].elapsed;
    assert.ok(after > before, 'elapsed should advance with local time');
    assert.equal(scheduler.calls.intervals, 1); // no timer leak/duplicate
  });

  it('setVisible(false) clears the timer; setVisible(true) restarts and refreshes', async () => {
    const { files } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    assert.equal(scheduler.calls.intervals, 1);
    assert.equal(scheduler.calls.handles.length, 1);

    await c.setVisible(false);
    assert.equal(scheduler.calls.handles.length, 0); // cleared
    assert.equal(scheduler.calls.cleared, 1);

    const callsBefore = fakeFiles.stats.sessionsListCalls;
    await c.setVisible(true);
    assert.equal(scheduler.calls.intervals, 2); // re-installed
    assert.equal(fakeFiles.stats.sessionsListCalls, callsBefore + 1); // immediate refresh
  });

  it('stop() clears the timer and stops future polls (no timer leak)', async () => {
    const { files } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    c.stop();
    assert.equal(scheduler.calls.handles.length, 0);
    const calls = fakeFiles.stats.sessionsListCalls;
    await c.refreshNow(); // no-op when stopped
    assert.equal(fakeFiles.stats.sessionsListCalls, calls);
  });

  it('refreshNow() triggers an immediate refresh when started (resume/pageshow)', async () => {
    const { files } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    const calls = fakeFiles.stats.sessionsListCalls;
    await c.refreshNow();
    assert.equal(fakeFiles.stats.sessionsListCalls, calls + 1);
  });

  it('never overlaps refreshActivity polls (single-flight + coalescing)', async () => {
    const { files } = smartSessionFiles();
    let release;
    const gate = new Promise((res) => { release = res; });
    const fakeFiles = createFakeFiles(files, { hooks: { gateSessions: () => gate } });
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    const p1 = c.start();               // tick 1 begins, blocked at the gate
    await new Promise((r) => setImmediate(r)); // let tick 1 reach the gate
    c.refreshNow();                     // requested while in flight -> coalesced
    c.refreshNow();                     // another request -> still only one queued
    assert.equal(fakeFiles.stats.maxConcurrentSessionsList, 1);
    release();
    await p1;
    await new Promise((r) => setImmediate(r)); // let the queued tick run
    await new Promise((r) => setImmediate(r));
    assert.equal(fakeFiles.stats.maxConcurrentSessionsList, 1); // never overlapped
    assert.equal(fakeFiles.stats.sessionsListCalls, 2); // original + exactly one coalesced
  });
});

describe('controller — stop control', () => {
  it('stopOne publishes exact ids/action/jobId', async () => {
    const { files, sessionId, runtimeId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    const result = await c.stopOne(sessionId, 'j1');
    assert.equal(result.ok, true);
    const pub = publishedEnvelope(files);
    assert.ok(pub, 'request file published');
    assert.equal(pub.envelope.action, 'stop_one');
    assert.equal(pub.envelope.jobId, 'j1');
    assert.equal(pub.envelope.sessionId, sessionId);
    assert.equal(pub.envelope.runtimeId, runtimeId);
    assert.equal(pub.envelope.generation, 0);
    assert.equal(pub.envelope.controlToken, `token-${runtimeId}`); // exact handshake secret
  });

  it('stopAll publishes stop_all without a jobId', async () => {
    const { files, sessionId, runtimeId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    const result = await c.stopAll(sessionId);
    assert.equal(result.ok, true);
    const pub = publishedEnvelope(files);
    assert.equal(pub.envelope.action, 'stop_all');
    assert.equal(pub.envelope.jobId, undefined);
    assert.equal(pub.envelope.runtimeId, runtimeId);
  });

  it('prevents duplicate pending actions', async () => {
    const { files, sessionId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    assert.equal((await c.stopAll(sessionId)).ok, true);
    const second = await c.stopAll(sessionId);
    assert.equal(second.ok, false);
    assert.match(second.reason, /already pending/);
    // only one request file ever written
    assert.equal(fakeFiles.callLog.filter((x) => x.method === 'writeFile').length, 1);
    // (a pending stop_all also blocks stop_one — asserted in the next test)
  });

  it('a pending stop_all blocks redundant stop_one for every job', async () => {
    const { files, sessionId } = smartSessionFiles({
      jobs: [mkJobJson('j1', 'running'), mkJobJson('j2', 'running')],
    });
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    assert.equal((await c.stopAll(sessionId)).ok, true);
    for (const jobId of ['j1', 'j2']) {
      const one = await c.stopOne(sessionId, jobId);
      assert.equal(one.ok, false, `stop_one ${jobId} must be redundant under pending stop_all`);
      assert.match(one.reason, /already pending/);
    }
    assert.equal(fakeFiles.callLog.filter((x) => x.method === 'writeFile').length, 1);
  });

  it('a pending stop_one does not block a stop_all escalation', async () => {
    const { files, sessionId } = smartSessionFiles({
      jobs: [mkJobJson('j1', 'running'), mkJobJson('j2', 'running')],
    });
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    assert.equal((await c.stopOne(sessionId, 'j1')).ok, true);
    const all = await c.stopAll(sessionId);
    assert.equal(all.ok, true); // superset escalation, not redundant
    assert.equal(fakeFiles.callLog.filter((x) => x.method === 'writeFile').length, 2);
  });

  it('rejects stopping an already-pending job', async () => {
    const { files, sessionId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    assert.equal((await c.stopOne(sessionId, 'j1')).ok, true);
    const second = await c.stopOne(sessionId, 'j1');
    assert.equal(second.ok, false);
    assert.match(second.reason, /already pending/);
  });

  it('explains unavailable when the smart runtime is stale', async () => {
    const { files, sessionId } = smartSessionFiles({ heartbeatAt: 1000 });
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    // clock well past the 15s staleness threshold
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 1000 + 20_000 });

    await c.start();
    const result = await c.stopAll(sessionId);
    assert.equal(result.ok, false);
    assert.match(result.reason, /stale/);
    assert.equal(fakeFiles.callLog.filter((x) => x.method === 'writeFile').length, 0);
  });

  it('explains unavailable when there is no smart runtime owner (plan-only)', async () => {
    const sessionId = 'sess1';
    const runtimeId = 'rt-plan';
    const files = {
      [sessionsDir()]: listDir(sessionId),
      [runtimesDir(sessionId)]: listDir(runtimeId),
      [`${runtimeDir(sessionId, runtimeId)}/runtime.json`]: JSON.stringify({
        schemaVersion: SCHEMA_VERSION, source: 'plan-mode', sessionId, runtimeId,
        generation: 0, state: 'active', startedAt: 1000, updatedAt: 2000, heartbeatAt: 2000,
      }),
    };
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    const result = await c.stopAll(sessionId);
    assert.equal(result.ok, false);
    assert.match(result.reason, /no smart runtime/);
  });

  it('explains unavailable for a terminal job', async () => {
    const { files, sessionId } = smartSessionFiles({
      jobs: [mkJobJson('j1', 'completed', { finishedAt: 300 })],
    });
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    const result = await c.stopOne(sessionId, 'j1');
    assert.equal(result.ok, false);
    assert.match(result.reason, /not active/);
  });
});

describe('controller — ack lifecycle', () => {
  it('accepts a matching ack, cleans up, and stops polling terminal requests', async () => {
    const { files, sessionId, runtimeId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    await c.stopAll(sessionId);
    const pub = publishedEnvelope(files);
    const requestId = pub.envelope.requestId;
    const acksPath = acksDir(sessionId, runtimeId);

    // First post-publish tick: no ack yet -> still pending (one ack list call).
    await c.refreshNow();
    let ackLists = fakeFiles.callLog.filter((x) => x.method === 'listFiles' && x.path === acksPath).length;
    assert.equal(ackLists, 1);

    // Backend writes the matching ack.
    files[acksPath] = listFiles(`${requestId}.json`);
    files[ackPath(sessionId, runtimeId, requestId)] = mkAckJson(sessionId, runtimeId, requestId, 'stop_all');
    files[pub.path] = JSON.stringify(pub.envelope);

    await c.refreshNow();
    ackLists = fakeFiles.callLog.filter((x) => x.method === 'listFiles' && x.path === acksPath).length;
    assert.equal(ackLists, 2);
    // cleanup deleted the request + ack files
    assert.ok(fakeFiles.callLog.some((x) => x.method === 'deleteFile' && x.path === pub.path));
    assert.ok(fakeFiles.callLog.some((x) => x.method === 'deleteFile' && x.path === ackPath(sessionId, runtimeId, requestId)));

    // Terminal request is no longer polled.
    await c.refreshNow();
    ackLists = fakeFiles.callLog.filter((x) => x.method === 'listFiles' && x.path === acksPath).length;
    assert.equal(ackLists, 2);
    // no UI error surfaced for acceptance
    assert.equal(c.getView(null).errors.length, 0);
  });

  it('rejected ack surfaces a bounded UI error and stops polling', async () => {
    const { files, sessionId, runtimeId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    await c.stopAll(sessionId);
    const pub = publishedEnvelope(files);
    const requestId = pub.envelope.requestId;
    const acksPath = acksDir(sessionId, runtimeId);

    files[acksPath] = listFiles(`${requestId}.json`);
    files[ackPath(sessionId, runtimeId, requestId)] = mkAckJson(sessionId, runtimeId, requestId, 'stop_all', { accepted: false, reason: 'control action failed' });
    files[pub.path] = JSON.stringify(pub.envelope);

    await c.refreshNow();
    const errors = c.getView(null).errors;
    assert.ok(errors.some((e) => /rejected/.test(e.message)));
    // still renders the last snapshot (not destroyed)
    assert.ok(c.getView(null).sessions.length >= 1);
  });

  it('timeout surfaces a bounded UI error and stops polling', async () => {
    const { files, sessionId, runtimeId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    let now = 5000;
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => now });

    await c.start();
    await c.stopAll(sessionId); // published at now=5000 (default TTL 10000)
    const acksPath = acksDir(sessionId, runtimeId);

    now = 16_000; // past expiresAt
    await c.refreshNow();
    assert.ok(c.getView(null).errors.some((e) => /timed out/.test(e.message)));
    const ackLists = fakeFiles.callLog.filter((x) => x.method === 'listFiles' && x.path === acksPath).length;
    assert.equal(ackLists, 1);

    now = 17_000;
    await c.refreshNow();
    // terminal -> no further ack polling
    assert.equal(fakeFiles.callLog.filter((x) => x.method === 'listFiles' && x.path === acksPath).length, 1);
  });
});

describe('controller — pending request retention', () => {
  it('capTerminalPendingRequests keeps every pending request and caps terminal history at 100', () => {
    const pendingRequests = {};
    for (let i = 0; i < 5; i++) {
      pendingRequests[`p${i}`] = {
        sessionId: 's', runtimeId: 'r', requestId: `p${i}`, status: 'pending',
        publishedAt: i, envelope: { action: 'stop_one', jobId: `j${i}` },
      };
    }
    for (let i = 0; i < 150; i++) {
      pendingRequests[`t${i}`] = {
        sessionId: 's', runtimeId: 'r', requestId: `t${i}`, status: 'timeout',
        publishedAt: i, envelope: { action: 'stop_all' },
      };
    }
    const state = { cacheKey: 'k', pendingRequests };
    const capped = capTerminalPendingRequests(state);

    const entries = Object.entries(capped.pendingRequests);
    assert.equal(entries.filter(([, r]) => r.status === 'pending').length, 5, 'pending never dropped');
    assert.equal(entries.filter(([, r]) => r.status !== 'pending').length, MAX_TERMINAL_PENDING_REQUESTS);
    // oldest 50 terminal entries evicted; newest 100 kept
    for (let i = 0; i < 50; i++) assert.equal(capped.pendingRequests[`t${i}`], undefined);
    assert.equal(capped.pendingRequests.t149.status, 'timeout');
    // original state untouched (immutability)
    assert.equal(state.pendingRequests.t0.status, 'timeout');
    assert.equal(Object.keys(state.pendingRequests).length, 155);
  });

  it('capTerminalPendingRequests is a no-op at or below the cap', () => {
    const state = { pendingRequests: { t1: { status: 'accepted', publishedAt: 1 } } };
    assert.equal(capTerminalPendingRequests(state), state);
    assert.equal(capTerminalPendingRequests(null), null);
    const noRequests = {};
    assert.equal(capTerminalPendingRequests(noRequests), noRequests); // passes through unchanged
  });

  it('100+ terminal stop requests never break rendering or error bounds', async () => {
    const jobs = [];
    for (let i = 0; i < 105; i++) jobs.push(mkJobJson(`j${i}`, 'running'));
    const { files, sessionId } = smartSessionFiles({ jobs });
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    let now = 5000;
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => now });

    await c.start();
    for (let i = 0; i < 105; i++) {
      const result = await c.stopOne(sessionId, `j${i}`);
      assert.equal(result.ok, true);
    }
    now = 12_000; // every 5s TTL has expired
    await c.refreshNow(); // drains all pending to timeout + applies the cap
    const view = c.getView(null);
    assert.equal(view.sessions.length, 1);
    assert.equal(view.sessions[0].jobs.length, 105);
    assert.ok(view.errors.length <= 20, 'errors stay bounded');
    await c.refreshNow(); // stable afterwards
    assert.equal(c.getView(null).sessions[0].jobs.length, 105);
  });
});

describe('controller — error isolation & secrecy', () => {
  it('publish failure is a bounded UI error and does not destroy the snapshot', async () => {
    const { files, sessionId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files, {
      hooks: { writeFile: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; } },
    });
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    const result = await c.stopAll(sessionId);
    assert.equal(result.ok, false);
    assert.match(result.reason, /disk full/);
    assert.ok(c.getView(null).errors.some((e) => /Stop failed/.test(e.message)));
    // last snapshot preserved
    assert.equal(c.getView(null).sessions.length, 1);
    assert.equal(c.getView(null).sessions[0].jobs.length, 1);
  });

  it('never exposes the control token, pid, or raw state via getView', async () => {
    const { files, sessionId } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    await c.start();
    await c.stopAll(sessionId);
    const json = JSON.stringify(c.getView(sessionId));
    assert.ok(!json.includes('token-rt1'), 'control token leaked');
    assert.ok(!json.includes('controlToken'));
    assert.ok(!json.includes('pid'));
    assert.ok(!json.includes('capabilities'));
    assert.ok(!json.includes('pendingRequests'));
  });

  it('subscribe receives fresh views and unsubscribe stops delivery', async () => {
    const { files } = smartSessionFiles();
    const fakeFiles = createFakeFiles(files);
    const scheduler = createFakeScheduler();
    const host = createFakeHost();
    const c = createActivityController({ files: fakeFiles, host, scheduler, clock: () => 5000 });

    const seen = [];
    const unsub = c.subscribe((view) => seen.push(view));
    await c.start();
    assert.ok(seen.length >= 1);
    unsub();
    await c.refreshNow();
    const after = seen.length;
    await c.refreshNow();
    assert.equal(seen.length, after);
  });
});
