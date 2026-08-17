// test-activity-store.mjs — node --test suite for activity-store.js
// Uses backend-shaped records (web-record.ts / plan-mode / registry.ts).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, SCHEMA_VERSION, HEARTBEAT_STALE_MS,
  sessionsDir, sessionDir, runtimesDir, runtimeDir,
  requestsDir, requestTempPath, requestFinalPath, acksDir, ackPath,
} from './activity-schema.js';
import {
  cacheKey, createInitialState, refreshActivity, publishControl, checkAck,
  getCapability, getPendingRequest, listPendingRequests,
  ERR_ROOT_ABSENT, ERR_DISCONNECTED,
} from './activity-store.js';

// ============================================================================
// Fake WorkspaceFiles
// ============================================================================

function createFakeFiles(files = {}, options = {}) {
  const callLog = [];
  const {
    failurePath = null,
    enoentPaths = new Set(),
    truncatedListPaths = new Set(),
    truncatedReadPaths = new Set(),
    binaryPaths = new Set(),
    nonUtf8Paths = new Set(),
  } = options;

  function checkFailure(path, method) {
    callLog.push({ method, path });
    if (failurePath && path === failurePath) {
      const err = new Error(`Simulated failure at ${path}`);
      err.code = 'EACCES';
      throw err;
    }
    if (enoentPaths.has(path)) {
      const err = new Error(`ENOENT: no such file or directory, open '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
  }

  return {
    callLog,
    async listFiles(path) {
      checkFailure(path, 'listFiles');
      const content = files[path];
      if (content === undefined) {
        // Treat as ENOENT if not explicitly listed
        const err = new Error(`ENOENT: no such directory '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      if (typeof content === 'object' && content.entries) {
        return { path, entries: content.entries, scannedAt: new Date().toISOString(), truncated: truncatedListPaths.has(path) };
      }
      throw new Error(`listFiles: ${path} is not a directory`);
    },
    async readFile(path) {
      checkFailure(path, 'readFile');
      const content = files[path];
      if (content === undefined) {
        const err = new Error(`ENOENT: no such file '${path}'`);
        err.code = 'ENOENT';
        throw err;
      }
      if (typeof content === 'string') {
        return {
          path,
          content,
          encoding: nonUtf8Paths.has(path) ? 'latin1' : 'utf8',
          size: content.length,
          modifiedAt: new Date().toISOString(),
          truncated: truncatedReadPaths.has(path),
          binary: binaryPaths.has(path),
        };
      }
      throw new Error(`readFile: ${path} is not a file`);
    },
    async writeFile(path, content, options = {}) {
      checkFailure(path, 'writeFile');
      if (files[path] !== undefined && !options.overwrite) {
        throw new Error(`File exists: ${path}`);
      }
      files[path] = content;
      return { path, size: content.length, modifiedAt: new Date().toISOString(), created: files[path] === undefined };
    },
    async moveFile(fromPath, toPath, options = {}) {
      callLog.push({ method: 'moveFile', fromPath, toPath });
      if (failurePath === fromPath || failurePath === toPath) {
        const err = new Error(`Simulated move failure`);
        err.code = 'EACCES';
        throw err;
      }
      if (files[fromPath] === undefined) {
        const err = new Error(`ENOENT: no such file '${fromPath}'`);
        err.code = 'ENOENT';
        throw err;
      }
      if (files[toPath] !== undefined && !options.overwrite) {
        throw new Error(`File exists: ${toPath}`);
      }
      files[toPath] = files[fromPath];
      delete files[fromPath];
      return { fromPath, toPath, size: files[toPath].length, modifiedAt: new Date().toISOString() };
    },
    async deleteFile(path) {
      callLog.push({ method: 'deleteFile', path });
      const existed = files[path] !== undefined;
      delete files[path];
      return { path, existed };
    },
  };
}

// ============================================================================
// Helpers — backend-shaped records
// ============================================================================

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

function mkPlanJson(sessionId, runtimeId, overrides = {}) {
  return JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    generation: 0,
    state: 'active',
    reason: 'proactive planning',
    since: 900,
    updatedAt: 3000,
    heartbeatAt: 3000,
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
  return { entries: names.map(name => ({ name, path: name, type: 'directory' })) };
}

function listFiles(...names) {
  return { entries: names.map(name => ({ name, path: name, type: 'file' })) };
}

function goodFiles() {
  return createFakeFiles({
    [sessionsDir()]: listDir('sess1'),
    [runtimesDir('sess1')]: listDir('rt1'),
    [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    [`${runtimeDir('sess1', 'rt1')}/agents.json`]: mkAgentsJson('sess1', 'rt1', [mkJobJson('j1', 'running')]),
    [`${runtimeDir('sess1', 'rt1')}/plan-mode.json`]: mkPlanJson('sess1', 'rt1'),
  });
}

async function goodState() {
  return refreshActivity(goodFiles(), createInitialState(), 5000);
}

// ============================================================================
// cacheKey helper
// ============================================================================

describe('cacheKey', () => {
  it('builds key from machine and workspace', () => {
    assert.equal(cacheKey({ id: 'm1' }, { id: 'w1' }), 'm1::w1');
  });

  it('handles null/undefined gracefully', () => {
    assert.equal(cacheKey(null, null), '::');
    assert.equal(cacheKey(undefined, undefined), '::');
    assert.equal(cacheKey({}, {}), '::');
  });

  it('does not assume selectedSession shape', () => {
    // Should work with just machine/workspace
    assert.equal(cacheKey({ id: 'm1' }, { id: 'w1' }), 'm1::w1');
  });
});

// ============================================================================
// createInitialState
// ============================================================================

describe('createInitialState', () => {
  it('creates empty state', () => {
    const state = createInitialState();
    assert.equal(state.cacheKey, '');
    assert.equal(state.disconnected, false);
    assert.equal(state.snapshot, null);
    assert.deepEqual(state.capabilities, {});
    assert.deepEqual(state.pendingRequests, {});
    assert.deepEqual(state.diagnostics, []);
    assert.equal(state.lastSuccessAt, null);
  });

  it('accepts custom cacheKey', () => {
    const state = createInitialState({ cacheKey: 'm1::w1' });
    assert.equal(state.cacheKey, 'm1::w1');
  });
});

// ============================================================================
// refreshActivity — empty root
// ============================================================================

describe('refreshActivity — empty root', () => {
  it('returns empty snapshot when sessions dir absent', async () => {
    const files = createFakeFiles({});
    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(state.disconnected, false);
    assert.deepEqual(state.snapshot, { sessions: {} });
    assert.equal(state.lastSuccessAt, 5000);
    assert.deepEqual(state.diagnostics, []);
  });

  it('returns empty snapshot when sessions dir exists but empty', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: { entries: [] },
    });
    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(state.disconnected, false);
    assert.deepEqual(state.snapshot, { sessions: {} });
  });
});

// ============================================================================
// refreshActivity — two sessions/multiple runtimes sorted
// ============================================================================

describe('refreshActivity — sorted enumeration', () => {
  it('enumerates sessions and runtimes in sorted order', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sessionB', 'sessionA'),
      [runtimesDir('sessionA')]: listDir('rt2', 'rt1'),
      [runtimesDir('sessionB')]: listDir('rt3'),
      [`${runtimeDir('sessionA', 'rt1')}/runtime.json`]: mkRuntimeJson('sessionA', 'rt1'),
      [`${runtimeDir('sessionA', 'rt2')}/runtime.json`]: mkRuntimeJson('sessionA', 'rt2'),
      [`${runtimeDir('sessionB', 'rt3')}/runtime.json`]: mkRuntimeJson('sessionB', 'rt3'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);

    assert.equal(state.disconnected, false);
    assert.ok(state.snapshot.sessions.sessionA);
    assert.ok(state.snapshot.sessions.sessionB);

    // Check runtimes are sorted
    assert.equal(state.snapshot.sessions.sessionA.runtimes.length, 2);
    assert.equal(state.snapshot.sessions.sessionA.runtimes[0].runtimeId, 'rt1');
    assert.equal(state.snapshot.sessions.sessionA.runtimes[1].runtimeId, 'rt2');

    assert.equal(state.snapshot.sessions.sessionB.runtimes.length, 1);
    assert.equal(state.snapshot.sessions.sessionB.runtimes[0].runtimeId, 'rt3');
  });

  it('includes agents and plans when present', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
      [`${runtimeDir('sess1', 'rt1')}/agents.json`]: mkAgentsJson('sess1', 'rt1', [mkJobJson('j1', 'running')]),
      [`${runtimeDir('sess1', 'rt1')}/plan-mode.json`]: mkPlanJson('sess1', 'rt1'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    const session = state.snapshot.sessions.sess1;

    assert.equal(session.agentsList.length, 1);
    assert.equal(session.agentsList[0].jobs.length, 1);
    assert.equal(session.agentsList[0].jobs[0].id, 'j1');
    assert.equal(session.plans.length, 1);
    assert.equal(session.plans[0].state, 'active');
    assert.equal(session.plans[0].reason, 'proactive planning');
  });

  it('preserves multiple generations as history in the snapshot', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', { generation: 2 }),
      [`${runtimeDir('sess1', 'rt1')}/agents.json`]: mkAgentsJson('sess1', 'rt1', [
        mkJobJson('j1', 'running'),
      ], { generation: 2 }),
      [`${runtimeDir('sess1', 'rt1')}/plan-mode.json`]: mkPlanJson('sess1', 'rt1', { generation: 2 }),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    const session = state.snapshot.sessions.sess1;
    assert.equal(session.runtimes[0].generation, 2);
    assert.equal(session.agentsList[0].generation, 2);
    assert.equal(session.plans[0].generation, 2);
  });
});

// ============================================================================
// refreshActivity — malformed data
// ============================================================================

describe('refreshActivity — malformed data', () => {
  it('ignores malformed session IDs', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('validSession', '../invalid', 'has/slash'),
      [runtimesDir('validSession')]: listDir('rt1'),
      [`${runtimeDir('validSession', 'rt1')}/runtime.json`]: mkRuntimeJson('validSession', 'rt1'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(Object.keys(state.snapshot.sessions).length, 1);
    assert.ok(state.snapshot.sessions.validSession);
  });

  it('ignores malformed runtime IDs', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('validRt', '../bad', 'has space'),
      [`${runtimeDir('sess1', 'validRt')}/runtime.json`]: mkRuntimeJson('sess1', 'validRt'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(state.snapshot.sessions.sess1.runtimes.length, 1);
    assert.equal(state.snapshot.sessions.sess1.runtimes[0].runtimeId, 'validRt');
  });

  it('ignores malformed JSON', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1', 'rt2'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: '{ invalid json',
      [`${runtimeDir('sess1', 'rt2')}/runtime.json`]: mkRuntimeJson('sess1', 'rt2'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(state.snapshot.sessions.sess1.runtimes.length, 1);
    assert.equal(state.snapshot.sessions.sess1.runtimes[0].runtimeId, 'rt2');
    assert.ok(state.diagnostics.length > 0);
  });

  it('ignores schema validation errors', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1', 'rt2'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: JSON.stringify({ schemaVersion: 99, sessionId: 'sess1', runtimeId: 'rt1' }),
      [`${runtimeDir('sess1', 'rt2')}/runtime.json`]: mkRuntimeJson('sess1', 'rt2'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(state.snapshot.sessions.sess1.runtimes.length, 1);
    assert.equal(state.snapshot.sessions.sess1.runtimes[0].runtimeId, 'rt2');
  });

  it('ignores runtime records whose session/runtime does not match the path', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1', 'rt2'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('OTHER', 'rt1'),
      [`${runtimeDir('sess1', 'rt2')}/runtime.json`]: mkRuntimeJson('sess1', 'rt2'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(state.snapshot.sessions.sess1.runtimes.length, 1);
    assert.equal(state.snapshot.sessions.sess1.runtimes[0].runtimeId, 'rt2');
  });

  it('ignores agents/plan records whose session/runtime does not match the path', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1', 'rt2'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
      [`${runtimeDir('sess1', 'rt1')}/agents.json`]: mkAgentsJson('OTHER', 'rt1', [mkJobJson('j1', 'running')]),
      [`${runtimeDir('sess1', 'rt1')}/plan-mode.json`]: mkPlanJson('sess1', 'OTHER'),
      [`${runtimeDir('sess1', 'rt2')}/runtime.json`]: mkRuntimeJson('sess1', 'rt2'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    const session = state.snapshot.sessions.sess1;
    assert.equal(session.agentsList.length, 0);
    assert.equal(session.plans.length, 0);
    assert.ok(state.diagnostics.some(d => d.message.includes('agents')));
    assert.ok(state.diagnostics.some(d => d.message.includes('plan-mode')));
  });

  it('ignores agents with unknown job status (never claims active)', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
      [`${runtimeDir('sess1', 'rt1')}/agents.json`]: mkAgentsJson('sess1', 'rt1', [
        mkJobJson('j1', 'bogus-status'),
      ]),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    const session = state.snapshot.sessions.sess1;
    assert.equal(session.agentsList.length, 0);
    assert.ok(state.diagnostics.some(d => d.message.includes('unknown status')));
  });
});

// ============================================================================
// refreshActivity — mid-poll disappearance
// ============================================================================

describe('refreshActivity — mid-poll disappearance', () => {
  it('tolerates runtime disappearing mid-poll', async () => {
    const callCount = { list: 0 };
    const files = {
      async listFiles(path) {
        callCount.list++;
        if (path === sessionsDir()) {
          return { path, entries: [{ name: 'sess1', path: 'sess1', type: 'directory' }] };
        }
        if (path === runtimesDir('sess1')) {
          // First call returns rt1, second call (if any) would be empty
          if (callCount.list === 2) {
            return { path, entries: [{ name: 'rt1', path: 'rt1', type: 'directory' }] };
          }
          return { path, entries: [] };
        }
        const err = new Error(`ENOENT: no such directory '${path}'`);
        err.code = 'ENOENT';
        throw err;
      },
      async readFile(path) {
        // Simulate runtime.json disappearing
        if (path.includes('rt1') && path.endsWith('runtime.json')) {
          const err = new Error(`ENOENT: no such file '${path}'`);
          err.code = 'ENOENT';
          throw err;
        }
        throw new Error(`Unexpected readFile: ${path}`);
      },
      async writeFile() { throw new Error('Not implemented'); },
      async moveFile() { throw new Error('Not implemented'); },
      async deleteFile() { throw new Error('Not implemented'); },
    };

    const state = await refreshActivity(files, createInitialState(), 5000);
    // Should succeed with empty session (runtime disappeared)
    assert.equal(state.disconnected, false);
    assert.deepEqual(state.snapshot.sessions, {});
  });
});

// ============================================================================
// refreshActivity — hard failure retains cache+disconnected
// ============================================================================

describe('refreshActivity — hard failure', () => {
  it('retains last good snapshot on disconnect', async () => {
    const goodFiles = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(goodFiles, createInitialState(), 5000);
    assert.equal(state.disconnected, false);
    assert.ok(state.snapshot.sessions.sess1);

    // Now simulate hard failure
    const badFiles = createFakeFiles({}, { failurePath: sessionsDir() });
    state = await refreshActivity(badFiles, state, 6000);

    assert.equal(state.disconnected, true);
    assert.ok(state.snapshot.sessions.sess1); // Retained from before
    assert.equal(state.lastSuccessAt, 5000); // Not updated
  });

  it('marks disconnected on hard failure', async () => {
    const files = createFakeFiles({}, { failurePath: sessionsDir() });
    const state = await refreshActivity(files, createInitialState(), 5000);

    assert.equal(state.disconnected, true);
    assert.ok(state.diagnostics.length > 0);
    assert.equal(state.diagnostics[0].level, 'error');
  });
});

// ============================================================================
// refreshActivity — nested hard failures retain last-good cache
// ============================================================================

describe('refreshActivity — nested hard failures', () => {
  const cases = [
    {
      label: 'runtimes list',
      diag: 'runtimes',
      badFiles: () => createFakeFiles(
        { [sessionsDir()]: listDir('sess1') },
        { failurePath: runtimesDir('sess1') },
      ),
    },
    {
      label: 'runtime.json',
      diag: 'runtime.json',
      badFiles: () => createFakeFiles(
        {
          [sessionsDir()]: listDir('sess1'),
          [runtimesDir('sess1')]: listDir('rt1'),
        },
        { failurePath: `${runtimeDir('sess1', 'rt1')}/runtime.json` },
      ),
    },
    {
      label: 'agents.json',
      diag: 'agents.json',
      badFiles: () => createFakeFiles(
        {
          [sessionsDir()]: listDir('sess1'),
          [runtimesDir('sess1')]: listDir('rt1'),
          [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
        },
        { failurePath: `${runtimeDir('sess1', 'rt1')}/agents.json` },
      ),
    },
    {
      label: 'plan-mode.json',
      diag: 'plan-mode.json',
      badFiles: () => createFakeFiles(
        {
          [sessionsDir()]: listDir('sess1'),
          [runtimesDir('sess1')]: listDir('rt1'),
          [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
          [`${runtimeDir('sess1', 'rt1')}/agents.json`]: mkAgentsJson('sess1', 'rt1', [mkJobJson('j1', 'running')]),
        },
        { failurePath: `${runtimeDir('sess1', 'rt1')}/plan-mode.json` },
      ),
    },
  ];

  for (const c of cases) {
    it(`retains snapshot+capabilities and marks disconnected on ${c.label} hard failure`, async () => {
      const prev = await goodState();
      assert.equal(prev.disconnected, false);
      assert.ok(prev.snapshot.sessions.sess1);
      assert.ok(prev.capabilities['sess1/rt1']);

      const state = await refreshActivity(c.badFiles(), prev, 6000);

      assert.equal(state.disconnected, true);
      assert.deepEqual(state.snapshot, prev.snapshot);
      assert.deepEqual(state.capabilities, prev.capabilities);
      assert.equal(state.lastSuccessAt, 5000); // not updated
      assert.ok(state.diagnostics.some(d => d.level === 'error' && d.message.includes(c.diag)));
    });
  }
});

// ============================================================================
// refreshActivity — truncated/binary/non-utf8 reads fail disconnected
// ============================================================================

describe('refreshActivity — truncation/binary/non-utf8', () => {
  it('treats truncated sessions list as disconnected and retains cache', async () => {
    const prev = await goodState();
    const files = createFakeFiles(
      { [sessionsDir()]: listDir('sess1') },
      { truncatedListPaths: new Set([sessionsDir()]) },
    );
    const state = await refreshActivity(files, prev, 6000);

    assert.equal(state.disconnected, true);
    assert.deepEqual(state.snapshot, prev.snapshot);
    assert.deepEqual(state.capabilities, prev.capabilities);
    assert.ok(state.diagnostics.some(d => d.level === 'error' && d.message.includes('sessions')));
  });

  it('treats truncated runtime.json read as disconnected and retains cache', async () => {
    const prev = await goodState();
    const files = createFakeFiles(
      {
        [sessionsDir()]: listDir('sess1'),
        [runtimesDir('sess1')]: listDir('rt1'),
        [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
      },
      { truncatedReadPaths: new Set([`${runtimeDir('sess1', 'rt1')}/runtime.json`]) },
    );
    const state = await refreshActivity(files, prev, 6000);

    assert.equal(state.disconnected, true);
    assert.deepEqual(state.snapshot, prev.snapshot);
    assert.deepEqual(state.capabilities, prev.capabilities);
  });

  it('treats binary runtime.json read as disconnected and retains cache', async () => {
    const prev = await goodState();
    const files = createFakeFiles(
      {
        [sessionsDir()]: listDir('sess1'),
        [runtimesDir('sess1')]: listDir('rt1'),
        [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
      },
      { binaryPaths: new Set([`${runtimeDir('sess1', 'rt1')}/runtime.json`]) },
    );
    const state = await refreshActivity(files, prev, 6000);

    assert.equal(state.disconnected, true);
    assert.deepEqual(state.snapshot, prev.snapshot);
    assert.deepEqual(state.capabilities, prev.capabilities);
  });

  it('treats non-utf8 runtime.json read as disconnected and retains cache', async () => {
    const prev = await goodState();
    const files = createFakeFiles(
      {
        [sessionsDir()]: listDir('sess1'),
        [runtimesDir('sess1')]: listDir('rt1'),
        [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
      },
      { nonUtf8Paths: new Set([`${runtimeDir('sess1', 'rt1')}/runtime.json`]) },
    );
    const state = await refreshActivity(files, prev, 6000);

    assert.equal(state.disconnected, true);
    assert.deepEqual(state.snapshot, prev.snapshot);
    assert.deepEqual(state.capabilities, prev.capabilities);
  });
});

// ============================================================================
// refreshActivity — recovery
// ============================================================================

describe('refreshActivity — recovery', () => {
  it('recovers after disconnect', async () => {
    // Start with good data
    const goodFiles = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(goodFiles, createInitialState(), 5000);
    assert.equal(state.disconnected, false);

    // Simulate disconnect
    const badFiles = createFakeFiles({}, { failurePath: sessionsDir() });
    state = await refreshActivity(badFiles, state, 6000);
    assert.equal(state.disconnected, true);

    // Recover
    const recoveredFiles = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt2'),
      [`${runtimeDir('sess1', 'rt2')}/runtime.json`]: mkRuntimeJson('sess1', 'rt2'),
    });
    state = await refreshActivity(recoveredFiles, state, 7000);

    assert.equal(state.disconnected, false);
    assert.ok(state.snapshot.sessions.sess1);
    assert.equal(state.snapshot.sessions.sess1.runtimes[0].runtimeId, 'rt2');
    assert.equal(state.lastSuccessAt, 7000);
  });
});

// ============================================================================
// refreshActivity — empty clears cache
// ============================================================================

describe('refreshActivity — empty clears cache', () => {
  it('clears stale cache on empty success', async () => {
    // Start with data
    const goodFiles = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(goodFiles, createInitialState(), 5000);
    assert.ok(state.snapshot.sessions.sess1);

    // Now empty
    const emptyFiles = createFakeFiles({
      [sessionsDir()]: { entries: [] },
    });
    state = await refreshActivity(emptyFiles, state, 6000);

    assert.deepEqual(state.snapshot, { sessions: {} });
    assert.deepEqual(state.capabilities, {});
  });
});

// ============================================================================
// capability secrecy
// ============================================================================

describe('capability secrecy', () => {
  it('does not expose controlToken in snapshot', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    const runtime = state.snapshot.sessions.sess1.runtimes[0];

    assert.equal(runtime.controlToken, undefined);
    assert.equal(runtime.pid, undefined);
  });

  it('stores capability in private map', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    const capability = getCapability(state, 'sess1', 'rt1');

    assert.ok(capability);
    assert.equal(capability.controlToken, 'token-rt1');
    assert.equal(capability.sessionId, 'sess1');
    assert.equal(capability.runtimeId, 'rt1');
    assert.equal(capability.generation, 0);
  });

  it('plan-mode runtimes have no capability', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', {
        source: 'plan-mode',
        controlToken: undefined,
        jobs: undefined,
      }),
    });

    const state = await refreshActivity(files, createInitialState(), 5000);
    assert.equal(getCapability(state, 'sess1', 'rt1'), null);
    assert.equal(state.snapshot.sessions.sess1.runtimes[0].source, 'plan-mode');
  });

  it('getCapability returns null for missing', () => {
    const state = createInitialState();
    assert.equal(getCapability(state, 'sess1', 'rt1'), null);
  });
});

// ============================================================================
// publishControl — atomic operation order/options
// ============================================================================

describe('publishControl — atomic operation', () => {
  it('writes temp then moves to final with overwrite:false', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      ttlMs: 5000,
      now: 6000,
    });

    // Check operation order
    const writeCalls = files.callLog.filter(c => c.method === 'writeFile');
    const moveCalls = files.callLog.filter(c => c.method === 'moveFile');

    assert.equal(writeCalls.length, 1);
    assert.equal(moveCalls.length, 1);
    assert.match(writeCalls[0].path, /\/\.[A-Za-z0-9._-]+\.tmp$/);
    assert.ok(!writeCalls[0].path.endsWith('.json'), 'staging file must be invisible to the backend JSON poller');
    assert.ok(moveCalls[0].toPath.endsWith('.json'));
    assert.ok(!moveCalls[0].toPath.split('/').at(-1).startsWith('.'));
  });

  it('tracks pending request', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
    assert.equal(pending[0].sessionId, 'sess1');
    assert.equal(pending[0].runtimeId, 'rt1');
    assert.ok(pending[0].requestId);
    assert.ok(pending[0].envelope);
  });

  it('envelope matches the backend top-level request protocol', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    assert.deepEqual(Object.keys(pending.envelope).sort(), [
      'action', 'controlToken', 'createdAt', 'expiresAt', 'generation',
      'requestId', 'runtimeId', 'schemaVersion', 'sessionId',
    ]);
    assert.equal(pending.envelope.generation, 0);
    assert.equal(pending.envelope.controlToken, 'token-rt1'); // handshake secret required by the backend
  });
});

// ============================================================================
// publishControl — move failure cleanup
// ============================================================================

describe('publishControl — move failure cleanup', () => {
  it('cleans up temp file on move failure', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };

    let tempPath = null;
    const files = {
      callLog: [],
      async listFiles(path) {
        this.callLog.push({ method: 'listFiles', path });
        if (rawFiles[path] && typeof rawFiles[path] === 'object' && rawFiles[path].entries) {
          return { path, entries: rawFiles[path].entries };
        }
        const err = new Error(`ENOENT: no such directory '${path}'`);
        err.code = 'ENOENT';
        throw err;
      },
      async readFile(path) {
        this.callLog.push({ method: 'readFile', path });
        if (typeof rawFiles[path] === 'string') {
          return { path, content: rawFiles[path], encoding: 'utf8', size: rawFiles[path].length };
        }
        const err = new Error(`ENOENT: no such file '${path}'`);
        err.code = 'ENOENT';
        throw err;
      },
      async writeFile(path, content) {
        this.callLog.push({ method: 'writeFile', path });
        tempPath = path;
        rawFiles[path] = content;
        return { path, size: content.length };
      },
      async moveFile(fromPath, toPath) {
        this.callLog.push({ method: 'moveFile', fromPath, toPath });
        const err = new Error('Simulated move failure');
        err.code = 'EACCES';
        throw err;
      },
      async deleteFile(path) {
        this.callLog.push({ method: 'deleteFile', path });
        delete rawFiles[path];
        return { path, existed: true };
      },
    };

    let state = await refreshActivity(files, createInitialState(), 5000);

    await assert.rejects(async () => {
      await publishControl(files, state, {
        sessionId: 'sess1',
        runtimeId: 'rt1',
        action: 'stop_all',
        ttlMs: 5000,
        now: 6000,
      });
    }, /move failure/);

    // Check that temp was cleaned up
    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0].path, tempPath);
  });
});

// ============================================================================
// publishControl — stale owner refusal
// ============================================================================

describe('publishControl — stale owner refusal', () => {
  it('refuses shutdown runtime even with a fresh heartbeat', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', {
        state: 'shutdown',
        heartbeatAt: 5000,
      }),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);

    await assert.rejects(async () => {
      await publishControl(files, state, {
        sessionId: 'sess1',
        runtimeId: 'rt1',
        action: 'stop_all',
        ttlMs: 5000,
        now: 6000,
      });
    }, /shutdown/);
  });

  it('refuses stale runtime', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', {
        heartbeatAt: 1000,
      }),
    });

    let state = await refreshActivity(files, createInitialState(), 5000 + HEARTBEAT_STALE_MS + 1);

    await assert.rejects(async () => {
      await publishControl(files, state, {
        sessionId: 'sess1',
        runtimeId: 'rt1',
        action: 'stop_all',
        ttlMs: 5000,
        now: 5000 + HEARTBEAT_STALE_MS + 1,
      });
    }, /stale/);
  });

  it('refuses an owner heartbeat older than the requested TTL before runtime is globally stale', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', {
        heartbeatAt: 1000,
      }),
    });

    const state = await refreshActivity(files, createInitialState(), 7000);
    await assert.rejects(async () => {
      await publishControl(files, state, {
        sessionId: 'sess1',
        runtimeId: 'rt1',
        action: 'stop_all',
        ttlMs: 5000,
        now: 7000,
      });
    }, /owner heartbeat is older than the control request TTL/);
    assert.equal(files.callLog.some((entry) => entry.method === 'writeFile'), false);
  });

  it('refuses active runtime with missing heartbeat (never fresh)', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', {
        heartbeatAt: undefined,
      }),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);

    await assert.rejects(async () => {
      await publishControl(files, state, {
        sessionId: 'sess1',
        runtimeId: 'rt1',
        action: 'stop_all',
        ttlMs: 5000,
        now: 6000,
      });
    }, /stale/);
  });

  it('refuses missing capability (plan-mode runtime)', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1', {
        source: 'plan-mode',
        controlToken: undefined,
        jobs: undefined,
      }),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);

    await assert.rejects(async () => {
      await publishControl(files, state, {
        sessionId: 'sess1',
        runtimeId: 'rt1',
        action: 'stop_all',
        ttlMs: 5000,
        now: 6000,
      });
    }, /No capability/);
  });
});

// ============================================================================
// checkAck — matching/rejected/mismatched ack and cleanup confinement
// ============================================================================

describe('checkAck — matching ack', () => {
  it('accepts matching ack and cleans up', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };

    const files = createFakeFiles(rawFiles);
    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    // Add matching ack (backend names ack files <requestId>.json)
    rawFiles[ackPath('sess1', 'rt1', 'req1')] = mkAckJson('sess1', 'rt1', 'req1', 'stop_all');
    rawFiles[acksDir('sess1', 'rt1')] = listFiles('req1.json');
    rawFiles[pending.finalPath] = JSON.stringify(pending.envelope);

    state = await checkAck(files, state, requestKey, 7000);

    // Check status
    const updated = getPendingRequest(state, requestKey);
    assert.equal(updated.status, 'accepted');

    // Check cleanup
    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.ok(deleteCalls.length >= 2);
    assert.ok(deleteCalls.some(c => c.path === pending.finalPath));
    assert.ok(deleteCalls.some(c => c.path === ackPath('sess1', 'rt1', 'req1')));
  });
});

describe('checkAck — rejected ack', () => {
  it('rejects ack with mismatched identity and cleans up', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };

    const files = createFakeFiles(rawFiles);
    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    // Add ack with same requestId but different identity
    rawFiles[ackPath('sess1', 'rt1', 'req1')] = mkAckJson('OTHER', 'rt1', 'req1', 'stop_all');
    rawFiles[acksDir('sess1', 'rt1')] = listFiles('req1.json');
    rawFiles[pending.finalPath] = JSON.stringify(pending.envelope);

    state = await checkAck(files, state, requestKey, 7000);

    // Check status
    const updated = getPendingRequest(state, requestKey);
    assert.equal(updated.status, 'rejected');

    // Check cleanup (confinement: only our files)
    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.ok(deleteCalls.length >= 2);
    assert.ok(deleteCalls.some(c => c.path === pending.finalPath));
    assert.ok(deleteCalls.some(c => c.path === ackPath('sess1', 'rt1', 'req1')));
  });

  it('rejects ack with mismatched generation and cleans up', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };

    const files = createFakeFiles(rawFiles);
    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    rawFiles[ackPath('sess1', 'rt1', 'req1')] = mkAckJson('sess1', 'rt1', 'req1', 'stop_all', { generation: 1 });
    rawFiles[acksDir('sess1', 'rt1')] = listFiles('req1.json');
    rawFiles[pending.finalPath] = JSON.stringify(pending.envelope);

    state = await checkAck(files, state, requestKey, 7000);
    assert.equal(getPendingRequest(state, requestKey).status, 'rejected');
  });

  it('rejects matching ack with accepted:false (backend refused) and cleans up', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };

    const files = createFakeFiles(rawFiles);
    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    rawFiles[ackPath('sess1', 'rt1', 'req1')] = mkAckJson('sess1', 'rt1', 'req1', 'stop_all', { accepted: false, reason: 'control action failed' });
    rawFiles[acksDir('sess1', 'rt1')] = listFiles('req1.json');
    rawFiles[pending.finalPath] = JSON.stringify(pending.envelope);

    state = await checkAck(files, state, requestKey, 7000);
    assert.equal(getPendingRequest(state, requestKey).status, 'rejected');

    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.ok(deleteCalls.some(c => c.path === pending.finalPath));
    assert.ok(deleteCalls.some(c => c.path === ackPath('sess1', 'rt1', 'req1')));
  });
});

describe('checkAck — mismatched ack (different requestId)', () => {
  it('ignores ack with different requestId (no cleanup)', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };

    const files = createFakeFiles(rawFiles);
    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    // Add ack with different requestId
    rawFiles[ackPath('sess1', 'rt1', 'OTHER_REQ')] = mkAckJson('sess1', 'rt1', 'OTHER_REQ', 'stop_all');
    rawFiles[acksDir('sess1', 'rt1')] = listFiles('OTHER_REQ.json');

    state = await checkAck(files, state, requestKey, 7000);

    // Check status still pending
    const updated = getPendingRequest(state, requestKey);
    assert.equal(updated.status, 'pending');

    // Check no cleanup (different request)
    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.equal(deleteCalls.length, 0);
  });
});

describe('checkAck — timeout', () => {
  it('marks timeout when no ack and expired', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    // Check after timeout
    state = await checkAck(files, state, requestKey, 12000);

    const updated = getPendingRequest(state, requestKey);
    assert.equal(updated.status, 'timeout');
  });

  it('stays pending when not expired', async () => {
    const files = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });

    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;

    // Check before timeout
    state = await checkAck(files, state, requestKey, 10000);

    const updated = getPendingRequest(state, requestKey);
    assert.equal(updated.status, 'pending');
  });
});

// ============================================================================
// checkAck — timeout cleanup exact final request file
// ============================================================================

describe('checkAck — timeout cleanup', () => {
  async function publish(files) {
    let state = await refreshActivity(files, createInitialState(), 5000);
    state = await publishControl(files, state, {
      sessionId: 'sess1',
      runtimeId: 'rt1',
      action: 'stop_all',
      requestId: 'req1',
      ttlMs: 5000,
      now: 6000,
    });
    const pending = listPendingRequests(state)[0];
    const requestKey = `${pending.sessionId}/${pending.runtimeId}/${pending.requestId}`;
    return { state, pending, requestKey };
  }

  it('deletes the exact final request file on timeout when acks dir is absent', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };
    const files = createFakeFiles(rawFiles);
    const { state, pending, requestKey } = await publish(files);

    rawFiles[pending.finalPath] = JSON.stringify(pending.envelope);
    const siblingPath = pending.finalPath.replace('req1.json', 'other.json');
    rawFiles[siblingPath] = JSON.stringify(pending.envelope);

    const next = await checkAck(files, state, requestKey, 12000); // expiresAt 11000

    assert.equal(getPendingRequest(next, requestKey).status, 'timeout');
    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.ok(deleteCalls.some(c => c.path === pending.finalPath), 'must delete exact final request file');
    assert.ok(!deleteCalls.some(c => c.path === siblingPath), 'must not delete sibling paths');
    assert.equal(rawFiles[pending.finalPath], undefined);
    assert.equal(rawFiles[siblingPath], JSON.stringify(pending.envelope));
  });

  it('deletes the exact final request file on timeout when no matching ack exists', async () => {
    const rawFiles = {
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    };
    const files = createFakeFiles(rawFiles);
    const { state, pending, requestKey } = await publish(files);

    rawFiles[pending.finalPath] = JSON.stringify(pending.envelope);
    const siblingPath = pending.finalPath.replace('req1.json', 'other.json');
    rawFiles[siblingPath] = JSON.stringify(pending.envelope);

    // An acks dir exists but only carries a different request's ack.
    rawFiles[acksDir('sess1', 'rt1')] = listFiles('other.json');
    rawFiles[ackPath('sess1', 'rt1', 'other')] = mkAckJson('sess1', 'rt1', 'other', 'stop_all');

    const next = await checkAck(files, state, requestKey, 12000); // expiresAt 11000

    assert.equal(getPendingRequest(next, requestKey).status, 'timeout');
    const deleteCalls = files.callLog.filter(c => c.method === 'deleteFile');
    assert.ok(deleteCalls.some(c => c.path === pending.finalPath), 'must delete exact final request file');
    assert.ok(!deleteCalls.some(c => c.path === ackPath('sess1', 'rt1', 'other')), 'must not delete foreign ack');
    assert.ok(!deleteCalls.some(c => c.path === siblingPath), 'must not delete sibling paths');
    assert.equal(rawFiles[ackPath('sess1', 'rt1', 'other')], mkAckJson('sess1', 'rt1', 'other', 'stop_all'));
  });
});

// ============================================================================
// cacheKey change detection
// ============================================================================

describe('refreshActivity — cacheKey change', () => {
  it('clears cache when cacheKey changes', async () => {
    const files1 = createFakeFiles({
      [sessionsDir()]: listDir('sess1'),
      [runtimesDir('sess1')]: listDir('rt1'),
      [`${runtimeDir('sess1', 'rt1')}/runtime.json`]: mkRuntimeJson('sess1', 'rt1'),
    });

    let state = await refreshActivity(files1, createInitialState({ cacheKey: 'm1::w1' }), 5000);
    assert.ok(state.snapshot.sessions.sess1);

    // Change cacheKey
    const files2 = createFakeFiles({
      [sessionsDir()]: listDir('sess2'),
      [runtimesDir('sess2')]: listDir('rt2'),
      [`${runtimeDir('sess2', 'rt2')}/runtime.json`]: mkRuntimeJson('sess2', 'rt2'),
    });

    state = await refreshActivity(files2, state, 6000, { cacheKey: 'm2::w2' });
    assert.equal(state.cacheKey, 'm2::w2');
    assert.deepEqual(state.snapshot, null); // Cleared
    assert.deepEqual(state.capabilities, {});
  });
});

// ============================================================================
// Utilities
// ============================================================================

describe('utilities', () => {
  it('getPendingRequest returns null for missing', () => {
    const state = createInitialState();
    assert.equal(getPendingRequest(state, 'sess1/rt1/req1'), null);
  });

  it('listPendingRequests returns empty array for no requests', () => {
    const state = createInitialState();
    assert.deepEqual(listPendingRequests(state), []);
  });
});
