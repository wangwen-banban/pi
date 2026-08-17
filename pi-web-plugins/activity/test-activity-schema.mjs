// test-activity-schema.mjs — node --test suite for activity-schema.js
// Mirrors the ACTUAL backend contract written by:
//   extensions/smart-subagents/web-record.ts, extensions/plan-mode/index.ts,
//   extensions/web-activity/registry.ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BASE, SCHEMA_VERSION, HEARTBEAT_STALE_MS, CONTROL_MAX_TTL_MS,
  isSafeId, assertSafeId,
  sessionsDir, sessionDir, runtimesDir, runtimeDir,
  requestsDir, requestTempPath, requestFinalPath, acksDir, ackPath,
  parseRuntime, parseAgents, parseJob, parsePlan, parseBackgroundTasks, parseBackgroundTask, parseBackgroundRun, parseAck,
  extractSafeSessionId,
  computeStatus, computeJobTiming, projectSession, newestRuntimePerSource,
  isJobActive, isBackgroundRunActive, isActiveJobStatus, isTerminalJobStatus,
  buildControlEnvelope, matchAck,
} from './activity-schema.js';

// ---------- helpers ----------
// Record shapes are copied verbatim from the backend writers (web-record.ts /
// plan-mode/index.ts / registry.ts) — no invented identity/kind/createdAt/
// shutdown/items/ackId/at fields.

function mkRuntime(overrides = {}) {
  return {
    schemaVersion: 1,
    source: 'smart-subagents',
    sessionId: 'sess1',
    runtimeId: 'rt1',
    generation: 0,
    controlToken: 'secret-token-abc',
    state: 'active',
    startedAt: 1000,
    updatedAt: 1500,
    heartbeatAt: 1500,
    jobs: { total: 2, active: 1 },
    ...overrides,
  };
}

function mkAgents(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'sess1',
    runtimeId: 'rt1',
    generation: 0,
    updatedAt: 1500,
    jobs: [],
    ...overrides,
  };
}

function mkJob(overrides = {}) {
  return {
    id: 'j1',
    name: 'Job 1',
    status: 'running',
    stopping: false,
    queuePosition: undefined,
    createdAt: 100,
    startedAt: 200,
    finishedAt: undefined,
    lastOutputAt: undefined,
    lastProgressAt: 300,
    timeoutAt: 200_000,
    model: 'm/ref',
    modelName: 'name',
    providerName: 'provider',
    thinking: 'low',
    context: 'isolated',
    permission: 'workspace-write',
    progress: ['a', 'b'],
    changedFiles: ['x.js'],
    resultSummary: 'done',
    errorSummary: undefined,
    logPath: '/tmp/j1.json',
    ...overrides,
  };
}

// Exact literal from extensions/plan-mode/index.ts writePlanRecord (active).
function mkPlan(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'sess1',
    runtimeId: 'rt1',
    generation: 0,
    state: 'active',
    reason: 'proactive planning',
    since: 900,
    updatedAt: 2000,
    heartbeatAt: 2000,
    ...overrides,
  };
}

function mkBackground(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'sess1',
    runtimeId: 'bg1',
    generation: 1,
    revision: 3,
    updatedAt: 3000,
    tasks: [
      { id: 'run', name: 'run', status: 'in_progress', position: 0, updatedAt: 2500, runId: 'bg-run-1' },
      { id: 'next', name: 'next', status: 'pending', position: 1, updatedAt: 2500 },
    ],
    runs: [
      { id: 'bg-run-1', taskId: 'run', name: 'run', status: 'running', stopping: false, createdAt: 2000, startedAt: 2100, lastOutputAt: 2900, timeoutAt: 9000 },
    ],
    ...overrides,
  };
}

function mkAck(overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'sess1',
    runtimeId: 'rt1',
    generation: 0,
    requestId: 'req1',
    action: 'stop_one',
    jobId: 'j1',
    accepted: true,
    reason: 'stopped',
    respondedAt: 5000,
    ...overrides,
  };
}

// ========================================================================
// Path builders & safe IDs
// ========================================================================

describe('safe id validation', () => {
  it('accepts valid safe ids', () => {
    assert.equal(isSafeId('a'), true);
    assert.equal(isSafeId('abc123'), true);
    assert.equal(isSafeId('A.b-c_d'), true);
    assert.equal(isSafeId('x'.repeat(128)), true);
  });

  it('rejects empty, bad start, too long, special chars', () => {
    assert.equal(isSafeId(''), false);
    assert.equal(isSafeId('.leading'), false);
    assert.equal(isSafeId('-leading'), false);
    assert.equal(isSafeId('_leading'), false);
    assert.equal(isSafeId('x'.repeat(129)), false);
    assert.equal(isSafeId('has space'), false);
    assert.equal(isSafeId('has/slash'), false);
    assert.equal(isSafeId('has\\back'), false);
    assert.equal(isSafeId(null), false);
    assert.equal(isSafeId(undefined), false);
    assert.equal(isSafeId(42), false);
  });

  it('assertSafeId throws on invalid', () => {
    assert.throws(() => assertSafeId(''), /invalid safe id/);
    assert.throws(() => assertSafeId('..'), /invalid safe id/);
    assert.throws(() => assertSafeId(null), /invalid safe id/);
  });
});

describe('path builders', () => {
  it('builds correct base paths', () => {
    assert.equal(sessionsDir(), `${BASE}/sessions`);
    assert.equal(sessionDir('s1'), `${BASE}/sessions/s1`);
    assert.equal(runtimesDir('s1'), `${BASE}/sessions/s1/runtimes`);
    assert.equal(runtimeDir('s1', 'r1'), `${BASE}/sessions/s1/runtimes/r1`);
  });

  it('builds request paths', () => {
    assert.equal(
      requestTempPath('s1', 'r1', 'q1'),
      `${BASE}/sessions/s1/runtimes/r1/requests/.q1.tmp`,
    );
    assert.equal(
      requestFinalPath('s1', 'r1', 'q1'),
      `${BASE}/sessions/s1/runtimes/r1/requests/q1.json`,
    );
  });

  it('builds ack paths (backend acks are named <requestId>.json)', () => {
    assert.equal(
      ackPath('s1', 'r1', 'a1'),
      `${BASE}/sessions/s1/runtimes/r1/acks/a1.json`,
    );
  });

  it('rejects traversal in path segments', () => {
    assert.throws(() => sessionDir('..'), /invalid safe id/);
    assert.throws(() => sessionDir('/etc'), /invalid safe id/);
    assert.throws(() => sessionDir('has/slash'), /invalid safe id/);
    assert.throws(() => runtimeDir('s1', '..'), /invalid safe id/);
    assert.throws(() => requestTempPath('s1', 'r1', '..'), /invalid safe id/);
    assert.throws(() => ackPath('s1', 'r1', ''), /invalid safe id/);
  });

  it('rejects non-string ids', () => {
    assert.throws(() => sessionDir(null), /invalid safe id/);
    assert.throws(() => sessionDir(123), /invalid safe id/);
    assert.throws(() => sessionDir(undefined), /invalid safe id/);
  });
});

// ========================================================================
// parseRuntime
// ========================================================================

describe('parseRuntime', () => {
  it('parses valid smart runtime (exact backend shape)', () => {
    const { public: pub, capability } = parseRuntime(mkRuntime());
    assert.equal(pub.schemaVersion, 1);
    assert.equal(pub.sessionId, 'sess1');
    assert.equal(pub.runtimeId, 'rt1');
    assert.equal(pub.source, 'smart-subagents');
    assert.equal(pub.state, 'active');
    assert.equal(pub.generation, 0);
    assert.equal(pub.startedAt, 1000);
    assert.equal(pub.updatedAt, 1500);
    assert.equal(pub.heartbeatAt, 1500);
    assert.deepEqual(pub.jobs, { total: 2, active: 1 });
    assert.ok(capability);
    assert.equal(capability.controlToken, 'secret-token-abc');
    assert.equal(capability.generation, 0);
  });

  it('parses shutdown smart runtime without heartbeat', () => {
    const raw = mkRuntime({ state: 'shutdown', heartbeatAt: undefined });
    const { public: pub } = parseRuntime(raw);
    assert.equal(pub.state, 'shutdown');
    assert.equal(pub.heartbeatAt, null);
  });

  it('parses plan-mode runtime (no capability, no token)', () => {
    const raw = {
      schemaVersion: 1,
      source: 'plan-mode',
      sessionId: 'sess1',
      runtimeId: 'rt1',
      generation: 0,
      state: 'active',
      startedAt: 1000,
      updatedAt: 1500,
      heartbeatAt: 1500,
    };
    const { public: pub, capability } = parseRuntime(raw);
    assert.equal(pub.source, 'plan-mode');
    assert.equal(pub.state, 'active');
    assert.equal(capability, null);
  });

  it('parses shutdown plan-mode runtime without heartbeat', () => {
    const raw = {
      schemaVersion: 1,
      source: 'plan-mode',
      sessionId: 'sess1',
      runtimeId: 'rt1',
      generation: 0,
      state: 'shutdown',
      startedAt: 1000,
      updatedAt: 1500,
    };
    const { public: pub, capability } = parseRuntime(raw);
    assert.equal(pub.state, 'shutdown');
    assert.equal(pub.heartbeatAt, null);
    assert.equal(capability, null);
  });

  it('rejects non-object', () => {
    assert.throws(() => parseRuntime(null), /not an object/);
    assert.throws(() => parseRuntime('str'), /not an object/);
    assert.throws(() => parseRuntime([]), /not an object/);
  });

  it('rejects bad schemaVersion', () => {
    assert.throws(() => parseRuntime(mkRuntime({ schemaVersion: 2 })), /bad schemaVersion/);
    assert.throws(() => parseRuntime(mkRuntime({ schemaVersion: '1' })), /bad schemaVersion/);
  });

  it('rejects unknown or missing source (strict)', () => {
    assert.throws(() => parseRuntime(mkRuntime({ source: 'cli' })), /unknown source/);
    assert.throws(() => parseRuntime(mkRuntime({ source: 'smart' })), /unknown source/);
    const raw = mkRuntime();
    delete raw.source;
    assert.throws(() => parseRuntime(raw), /unknown source/);
  });

  it('rejects invalid or missing state (strict)', () => {
    assert.throws(() => parseRuntime(mkRuntime({ state: 'running' })), /invalid state/);
    const raw = mkRuntime();
    delete raw.state;
    assert.throws(() => parseRuntime(raw), /invalid state/);
  });

  it('rejects unsafe sessionId/runtimeId', () => {
    assert.throws(() => parseRuntime(mkRuntime({ sessionId: '../etc' })), /unsafe/);
    assert.throws(() => parseRuntime(mkRuntime({ runtimeId: '..' })), /unsafe/);
  });

  it('rejects missing/invalid generation', () => {
    const raw = mkRuntime();
    delete raw.generation;
    assert.throws(() => parseRuntime(raw), /generation/);
    assert.throws(() => parseRuntime(mkRuntime({ generation: -1 })), /generation/);
    assert.throws(() => parseRuntime(mkRuntime({ generation: 1.5 })), /generation/);
    assert.throws(() => parseRuntime(mkRuntime({ generation: '1' })), /generation/);
  });

  it('rejects non-finite timestamps', () => {
    assert.throws(() => parseRuntime(mkRuntime({ startedAt: NaN })), /not finite/);
    assert.throws(() => parseRuntime(mkRuntime({ updatedAt: undefined })), /not finite/);
    assert.throws(() => parseRuntime(mkRuntime({ heartbeatAt: Infinity })), /not finite/);
  });

  it('rejects malformed jobs summary', () => {
    assert.throws(() => parseRuntime(mkRuntime({ jobs: [] })), /jobs/);
    assert.throws(() => parseRuntime(mkRuntime({ jobs: { total: 'x', active: 1 } })), /jobs.total/);
    assert.throws(() => parseRuntime(mkRuntime({ jobs: { total: 1, active: -1 } })), /jobs.active/);
  });

  it('tolerates unknown fields', () => {
    const raw = mkRuntime();
    raw.extraField = { nested: 'data' };
    const { public: pub } = parseRuntime(raw);
    assert.equal(pub.sessionId, 'sess1');
    assert.equal(pub.extraField, undefined);
  });
});

// ========================================================================
// Token secrecy
// ========================================================================

describe('token secrecy', () => {
  it('public projection excludes controlToken and pid', () => {
    const { public: pub } = parseRuntime(mkRuntime({ pid: 4242 }));
    assert.equal(pub.controlToken, undefined);
    assert.equal(pub.pid, undefined);
  });

  it('public projection has no identity/kind/createdAt/shutdown', () => {
    const { public: pub } = parseRuntime(mkRuntime({
      kind: 'smart',
      createdAt: 42,
      identity: { sessionId: 'x', runtimeId: 'y', createdAt: 42 },
      shutdown: { at: 42, reason: 'x' },
    }));
    assert.equal(pub.identity, undefined);
    assert.equal(pub.kind, undefined);
    assert.equal(pub.createdAt, undefined);
    assert.equal(pub.shutdown, undefined);
  });

  it('capability includes controlToken but never pid', () => {
    const { capability } = parseRuntime(mkRuntime({ pid: 4242 }));
    assert.equal(capability.controlToken, 'secret-token-abc');
    assert.equal(capability.pid, undefined);
  });

  it('rejects smart runtime without controlToken', () => {
    const raw = mkRuntime();
    delete raw.controlToken;
    assert.throws(() => parseRuntime(raw), /smart runtime requires controlToken/);
  });

  it('rejects smart runtime with empty controlToken', () => {
    assert.throws(() => parseRuntime(mkRuntime({ controlToken: '' })), /smart runtime requires controlToken/);
  });
});

// ========================================================================
// parseAgents / parseJob
// ========================================================================

describe('parseAgents', () => {
  it('parses valid agents with backend jobs', () => {
    const raw = mkAgents({
      jobs: [
        mkJob({ id: 'j1', status: 'running' }),
        mkJob({ id: 'j2', status: 'completed', startedAt: 50, finishedAt: 200 }),
      ],
    });
    const result = parseAgents(raw);
    assert.equal(result.jobs.length, 2);
    assert.equal(result.jobs[0].id, 'j1');
    assert.equal(result.jobs[1].status, 'completed');
    assert.equal(result.generation, 0);
    assert.equal(result.updatedAt, 1500);
  });

  it('accepts every allowed lifecycle status', () => {
    for (const status of ['routing', 'queued', 'running', 'completed', 'failed', 'stopped']) {
      const result = parseAgents(mkAgents({ jobs: [mkJob({ status })] }));
      assert.equal(result.jobs[0].status, status);
    }
  });

  it('rejects non-object', () => {
    assert.throws(() => parseAgents(null), /not an object/);
    assert.throws(() => parseAgents([]), /not an object/);
  });

  it('rejects bad schemaVersion', () => {
    assert.throws(() => parseAgents(mkAgents({ schemaVersion: 99 })), /bad schemaVersion/);
  });

  it('rejects unsafe sessionId', () => {
    assert.throws(() => parseAgents(mkAgents({ sessionId: '..' })), /unsafe/);
  });

  it('rejects missing/invalid generation', () => {
    const raw = mkAgents();
    delete raw.generation;
    assert.throws(() => parseAgents(raw), /generation/);
    assert.throws(() => parseAgents(mkAgents({ generation: -1 })), /generation/);
  });

  it('rejects missing updatedAt', () => {
    const raw = mkAgents();
    delete raw.updatedAt;
    assert.throws(() => parseAgents(raw), /updatedAt/);
  });

  it('rejects too many jobs', () => {
    const jobs = Array.from({ length: 257 }, (_, i) => mkJob({ id: `j${i}` }));
    assert.throws(() => parseAgents(mkAgents({ jobs })), /too long/);
  });

  it('tolerates unknown fields', () => {
    const raw = mkAgents({ jobs: [mkJob({ extra: true })] });
    const result = parseAgents(raw);
    assert.equal(result.jobs[0].extra, undefined);
  });
});

describe('parseJob', () => {
  it('parses the full backend job field set', () => {
    const j = parseJob(mkJob());
    assert.deepEqual(j, {
      id: 'j1',
      name: 'Job 1',
      status: 'running',
      stopping: false,
      queuePosition: undefined,
      createdAt: 100,
      startedAt: 200,
      finishedAt: undefined,
      lastOutputAt: undefined,
      lastProgressAt: 300,
      timeoutAt: 200_000,
      model: 'm/ref',
      modelName: 'name',
      providerName: 'provider',
      thinking: 'low',
      context: 'isolated',
      permission: 'workspace-write',
      progress: ['a', 'b'],
      changedFiles: ['x.js'],
      resultSummary: 'done',
      errorSummary: undefined,
      logPath: '/tmp/j1.json',
    });
  });

  it('parses stopping flag and queue position', () => {
    const j = parseJob(mkJob({ stopping: true, queuePosition: 2, status: 'running' }));
    assert.equal(j.stopping, true);
    assert.equal(j.queuePosition, 2);
  });

  it('rejects non-object', () => {
    assert.throws(() => parseJob(null), /not an object/);
    assert.throws(() => parseJob('str'), /not an object/);
  });

  it('rejects unsafe id', () => {
    assert.throws(() => parseJob(mkJob({ id: '..' })), /unsafe/);
  });

  it('rejects missing name', () => {
    const raw = mkJob();
    delete raw.name;
    assert.throws(() => parseJob(raw), /name/);
  });

  it('NEVER defaults unknown status to running (strict reject)', () => {
    assert.throws(() => parseJob(mkJob({ status: 'bogus' })), /unknown status/);
    assert.throws(() => parseJob(mkJob({ status: 'cancelled' })), /unknown status/);
    const raw = mkJob();
    delete raw.status;
    assert.throws(() => parseJob(raw), /unknown status/);
  });

  it('rejects non-finite timestamps', () => {
    assert.throws(() => parseJob(mkJob({ createdAt: NaN })), /not finite/);
    assert.throws(() => parseJob(mkJob({ startedAt: 'x' })), /not finite/);
    assert.throws(() => parseJob(mkJob({ lastProgressAt: Infinity })), /not finite/);
  });

  it('rejects bad queue positions', () => {
    assert.throws(() => parseJob(mkJob({ queuePosition: 0 })), /queuePosition/);
    assert.throws(() => parseJob(mkJob({ queuePosition: -1 })), /queuePosition/);
    assert.throws(() => parseJob(mkJob({ queuePosition: 1.5 })), /queuePosition/);
  });

  it('rejects non-string progress/changedFiles entries', () => {
    assert.throws(() => parseJob(mkJob({ progress: [1] })), /not a string/);
    assert.throws(() => parseJob(mkJob({ changedFiles: 'x' })), /not an array/);
  });

  it('bounds strings and arrays', () => {
    // Strict bounded validation — the backend sanitizer never emits >512-char
    // strings or >200-item arrays, so oversized input is malformed.
    assert.throws(() => parseJob(mkJob({ name: 'x'.repeat(2000) })), /too long/);
    assert.throws(() => parseJob(mkJob({ resultSummary: 'x'.repeat(2000) })), /too long/);
    assert.throws(() => parseJob(mkJob({
      progress: Array.from({ length: 300 }, (_, i) => `p${i}`),
    })), /too long/);
  });

  it('does not surface legacy title/detail/endedAt/progress-object fields', () => {
    const j = parseJob(mkJob({ title: 't', detail: 'd', endedAt: 1, progress: undefined }));
    assert.equal(j.title, undefined);
    assert.equal(j.detail, undefined);
    assert.equal(j.endedAt, undefined);
  });
});

// ========================================================================
// parseBackgroundTasks
// ========================================================================

describe('parseBackgroundTasks', () => {
  it('parses dynamic task-plan and managed-run lifecycle records', () => {
    const result = parseBackgroundTasks(mkBackground());
    assert.equal(result.revision, 3);
    assert.deepEqual(result.tasks.map(task => [task.id, task.status]), [
      ['run', 'in_progress'],
      ['next', 'pending'],
    ]);
    assert.equal(result.runs[0].id, 'bg-run-1');
    assert.equal(result.runs[0].status, 'running');
    assert.equal(isBackgroundRunActive(result.runs[0]), true);
  });

  it('accepts every task and run terminal status without defaulting unknown values', () => {
    for (const status of ['pending', 'in_progress', 'completed', 'failed', 'blocked', 'cancelled']) {
      assert.equal(parseBackgroundTask({ id: 'task', name: 'task', status, position: 0, updatedAt: 1 }).status, status);
    }
    for (const status of ['running', 'completed', 'failed', 'stopped']) {
      assert.equal(parseBackgroundRun({ id: 'run', taskId: 'task', name: 'run', status, createdAt: 1 }).status, status);
    }
    assert.throws(() => parseBackgroundTask({ id: 'task', name: 'task', status: 'mystery', position: 0, updatedAt: 1 }), /unknown status/);
    assert.throws(() => parseBackgroundRun({ id: 'run', taskId: 'task', name: 'run', status: 'mystery', createdAt: 1 }), /unknown status/);
  });

  it('rejects duplicate or unsafe ids and malformed revision/timestamps', () => {
    assert.throws(() => parseBackgroundTasks(mkBackground({ revision: -1 })), /revision/);
    assert.throws(() => parseBackgroundTasks(mkBackground({ tasks: [
      { id: 'same', name: 'same', status: 'pending', position: 0, updatedAt: 1 },
      { id: 'same', name: 'same', status: 'pending', position: 1, updatedAt: 1 },
    ] })), /duplicate task id/);
    assert.throws(() => parseBackgroundTasks(mkBackground({ runs: [
      { id: '../bad', taskId: 'run', name: 'bad', status: 'running', createdAt: 1 },
    ] })), /unsafe id/);
    assert.throws(() => parseBackgroundTasks(mkBackground({ updatedAt: Number.NaN })), /updatedAt/);
  });

  it('never surfaces command, title, output, credential or pid fields', () => {
    const parsed = parseBackgroundTasks(mkBackground({
      command: 'secret command',
      title: 'secret title',
      output: 'secret output',
      apiKey: 'secret key',
      pid: 1234,
    }));
    const serialized = JSON.stringify(parsed);
    for (const secret of ['secret command', 'secret title', 'secret output', 'secret key', '1234']) {
      assert.equal(serialized.includes(secret), false);
    }
  });
});

// ========================================================================
// parsePlan
// ========================================================================

describe('parsePlan', () => {
  it('parses the exact active plan literal from plan-mode writer', () => {
    const result = parsePlan(mkPlan());
    assert.deepEqual(result, {
      schemaVersion: 1,
      sessionId: 'sess1',
      runtimeId: 'rt1',
      generation: 0,
      state: 'active',
      reason: 'proactive planning',
      since: 900,
      updatedAt: 2000,
      heartbeatAt: 2000,
    });
  });

  it('parses the exact inactive plan literal from plan-mode writer', () => {
    const result = parsePlan(mkPlan({ state: 'inactive', reason: '', since: 0 }));
    assert.equal(result.state, 'inactive');
    assert.equal(result.reason, '');
    assert.equal(result.since, 0);
  });

  it('has no active boolean and no items', () => {
    const result = parsePlan(mkPlan({ active: true, items: [{ title: 'x' }] }));
    assert.equal(result.active, undefined);
    assert.equal(result.items, undefined);
  });

  it('rejects non-object', () => {
    assert.throws(() => parsePlan(null), /not an object/);
  });

  it('rejects bad schemaVersion', () => {
    assert.throws(() => parsePlan(mkPlan({ schemaVersion: 0 })), /bad schemaVersion/);
  });

  it('rejects invalid state (strict)', () => {
    assert.throws(() => parsePlan(mkPlan({ state: 'on' })), /invalid state/);
    const raw = mkPlan();
    delete raw.state;
    assert.throws(() => parsePlan(raw), /invalid state/);
  });

  it('rejects missing/invalid generation, since, updatedAt', () => {
    const raw = mkPlan();
    delete raw.generation;
    assert.throws(() => parsePlan(raw), /generation/);
    assert.throws(() => parsePlan(mkPlan({ since: undefined })), /not finite/);
    assert.throws(() => parsePlan(mkPlan({ updatedAt: NaN })), /not finite/);
  });

  it('rejects non-finite heartbeatAt', () => {
    assert.throws(() => parsePlan(mkPlan({ heartbeatAt: Infinity })), /not finite/);
  });
});

// ========================================================================
// parseAck
// ========================================================================

describe('parseAck', () => {
  it('parses backend accepted ack', () => {
    const result = parseAck(mkAck());
    assert.deepEqual(result, {
      schemaVersion: 1,
      sessionId: 'sess1',
      runtimeId: 'rt1',
      generation: 0,
      requestId: 'req1',
      action: 'stop_one',
      jobId: 'j1',
      accepted: true,
      reason: 'stopped',
      respondedAt: 5000,
    });
  });

  it('parses backend rejected ack without action/jobId', () => {
    const result = parseAck(mkAck({ action: undefined, jobId: undefined, accepted: false, reason: 'sessionId mismatch' }));
    assert.equal(result.action, undefined);
    assert.equal(result.jobId, undefined);
    assert.equal(result.accepted, false);
  });

  it('rejects non-object', () => {
    assert.throws(() => parseAck(null), /not an object/);
  });

  it('rejects bad schemaVersion', () => {
    assert.throws(() => parseAck(mkAck({ schemaVersion: 7 })), /bad schemaVersion/);
  });

  it('rejects unsafe requestId', () => {
    assert.throws(() => parseAck(mkAck({ requestId: '../bad' })), /unsafe/);
  });

  it('rejects missing/invalid generation', () => {
    const raw = mkAck();
    delete raw.generation;
    assert.throws(() => parseAck(raw), /generation/);
  });

  it('rejects non-boolean accepted', () => {
    assert.throws(() => parseAck(mkAck({ accepted: 'yes' })), /accepted/);
  });

  it('rejects non-finite respondedAt', () => {
    assert.throws(() => parseAck(mkAck({ respondedAt: NaN })), /not finite/);
  });

  it('rejects unsupported action', () => {
    assert.throws(() => parseAck(mkAck({ action: 'pause' })), /unsupported action/);
  });

  it('bounds reason', () => {
    assert.throws(() => parseAck(mkAck({ reason: 'x'.repeat(5000) })), /too long/);
  });

  it('does not surface legacy ackId/identity/at fields', () => {
    const result = parseAck(mkAck({ ackId: 'a1', identity: {}, at: 1 }));
    assert.equal(result.ackId, undefined);
    assert.equal(result.identity, undefined);
    assert.equal(result.at, undefined);
  });
});

// ========================================================================
// extractSafeSessionId
// ========================================================================

describe('extractSafeSessionId', () => {
  it('extracts from string', () => {
    assert.equal(extractSafeSessionId('sess1'), 'sess1');
  });

  it('extracts from {id}', () => {
    assert.equal(extractSafeSessionId({ id: 'sess1' }), 'sess1');
  });

  it('extracts from {sessionId}', () => {
    assert.equal(extractSafeSessionId({ sessionId: 'sess1' }), 'sess1');
  });

  it('extracts from {session:{id}}', () => {
    assert.equal(extractSafeSessionId({ session: { id: 'sess1' } }), 'sess1');
  });

  it('extracts from {session:{sessionId}}', () => {
    assert.equal(extractSafeSessionId({ session: { sessionId: 'sess1' } }), 'sess1');
  });

  it('does NOT extract from arbitrary {key}', () => {
    assert.equal(extractSafeSessionId({ key: 'sess1' }), null);
  });

  it('returns null for null/undefined', () => {
    assert.equal(extractSafeSessionId(null), null);
    assert.equal(extractSafeSessionId(undefined), null);
  });

  it('returns null for unsafe string', () => {
    assert.equal(extractSafeSessionId('../etc'), null);
    assert.equal(extractSafeSessionId(''), null);
  });

  it('returns null for ambiguous (multiple distinct safe ids)', () => {
    const obj = { id: 'sess1', sessionId: 'sess2' };
    assert.equal(extractSafeSessionId(obj), null);
  });

  it('returns value when multiple fields agree', () => {
    const obj = { id: 'sess1', sessionId: 'sess1' };
    assert.equal(extractSafeSessionId(obj), 'sess1');
  });

  it('returns null for non-object non-string', () => {
    assert.equal(extractSafeSessionId(42), null);
    assert.equal(extractSafeSessionId(true), null);
  });

  it('returns null for empty object', () => {
    assert.equal(extractSafeSessionId({}), null);
  });
});

// ========================================================================
// computeStatus
// ========================================================================

describe('computeStatus', () => {
  it('returns idle for null runtime', () => {
    assert.equal(computeStatus(null, 5000), 'idle');
  });

  it('returns shutdown even with a recent heartbeat (terminal)', () => {
    const rt = { state: 'shutdown', heartbeatAt: 4000 };
    assert.equal(computeStatus(rt, 5000), 'shutdown');
  });

  it('returns shutdown without heartbeat', () => {
    const rt = { state: 'shutdown', heartbeatAt: null };
    assert.equal(computeStatus(rt, 5000), 'shutdown');
  });

  it('returns stale when heartbeat > 15s old', () => {
    const rt = { state: 'active', heartbeatAt: 1000 };
    assert.equal(computeStatus(rt, 1000 + HEARTBEAT_STALE_MS + 1), 'stale');
  });

  it('returns stale when active runtime has missing heartbeat (never fresh)', () => {
    const rt = { state: 'active', heartbeatAt: null };
    assert.equal(computeStatus(rt, 999999), 'stale');
  });

  it('returns active when heartbeat is fresh', () => {
    const rt = { state: 'active', heartbeatAt: 4000 };
    assert.equal(computeStatus(rt, 5000), 'active');
  });
});

// ========================================================================
// computeJobTiming
// ========================================================================

describe('computeJobTiming', () => {
  it('computes elapsed from startedAt', () => {
    const job = { startedAt: 1000, createdAt: 500 };
    const { elapsed, queueAge, progressAge, timedOut } = computeJobTiming(job, 5000);
    assert.equal(elapsed, 4000);
    assert.equal(queueAge, 4500);
    assert.equal(progressAge, 4000); // fallback to startedAt
    assert.equal(timedOut, false); // default timeout 60s
  });

  it('falls back to createdAt when not started', () => {
    const job = { createdAt: 1000 };
    const { elapsed, progressAge } = computeJobTiming(job, 5000);
    assert.equal(elapsed, 4000);
    assert.equal(progressAge, 4000);
  });

  it('prefers lastProgressAt then lastOutputAt for progress age', () => {
    const job = { createdAt: 100, startedAt: 1000, lastOutputAt: 3000, lastProgressAt: 4500 };
    const { progressAge } = computeJobTiming(job, 5000);
    assert.equal(progressAge, 500);
    const job2 = { createdAt: 100, startedAt: 1000, lastOutputAt: 3000 };
    assert.equal(computeJobTiming(job2, 5000).progressAge, 2000);
  });

  it('detects timeout from the job timeoutAt', () => {
    const job = { startedAt: 1000, timeoutAt: 4000, status: 'running' };
    assert.equal(computeJobTiming(job, 5000).timedOut, true);
    assert.equal(computeJobTiming(job, 3000).timedOut, false);
  });

  it('does not infer a timeout from silence without backend timeoutAt', () => {
    const job = { startedAt: 1000, createdAt: 1000, status: 'running' };
    assert.equal(computeJobTiming(job, 100000, 60000).timedOut, false);
  });

  it('does not mark terminal jobs timed out without timeoutAt and freezes elapsed at finishedAt', () => {
    const job = { startedAt: 1000, createdAt: 500, finishedAt: 5000, status: 'completed' };
    const timing = computeJobTiming(job, 100000, 100);
    assert.equal(timing.timedOut, false);
    assert.equal(timing.elapsed, 4000);
  });
});

// ========================================================================
// isJobActive / status helpers
// ========================================================================

describe('isJobActive', () => {
  it('counts routing/queued/running as active', () => {
    for (const status of ['routing', 'queued', 'running']) {
      assert.equal(isJobActive({ status, stopping: false }), true, status);
    }
  });

  it('counts stopping (stop requested, not yet terminal) as active', () => {
    assert.equal(isJobActive({ status: 'running', stopping: true }), true);
  });

  it('does not count terminal statuses as active even with stopping flag', () => {
    for (const status of ['completed', 'failed', 'stopped']) {
      assert.equal(isJobActive({ status, stopping: true }), false, status);
      assert.equal(isJobActive({ status, stopping: false }), false, status);
    }
  });

  it('rejects unknown/unknown-type statuses as not active', () => {
    assert.equal(isJobActive({ status: 'weird' }), false);
    assert.equal(isJobActive({ status: 'bogus', stopping: true }), false);
    assert.equal(isJobActive(null), false);
    assert.equal(isJobActive({ status: 'running' }, 42), true);
  });

  it('status helpers classify the six lifecycle values', () => {
    assert.deepEqual(
      ['routing', 'queued', 'running'].filter(isActiveJobStatus),
      ['routing', 'queued', 'running'],
    );
    assert.deepEqual(
      ['completed', 'failed', 'stopped'].filter(isTerminalJobStatus),
      ['completed', 'failed', 'stopped'],
    );
    assert.equal(isActiveJobStatus('stopped'), false);
    assert.equal(isTerminalJobStatus('running'), false);
  });
});

// ========================================================================
// projectSession — newest selection, generation binding, sorting, badge
// ========================================================================

describe('projectSession', () => {
  it('selects newest runtime per source by generation then startedAt then updatedAt', () => {
    const r1 = parseRuntime(mkRuntime({ runtimeId: 'r1', generation: 2, startedAt: 100 })).public;
    const r2 = parseRuntime(mkRuntime({ runtimeId: 'r2', generation: 3, startedAt: 50 })).public;
    const r3 = parseRuntime(mkRuntime({ runtimeId: 'r3', generation: 3, startedAt: 80 })).public;
    const proj = projectSession({ runtimes: [r1, r2, r3], now: 500 });
    assert.equal(proj.sources.get('smart-subagents').runtimeId, 'r3'); // same generation, later startedAt
    assert.equal(proj.primary.runtimeId, 'r3');
  });

  it('ties broken by updatedAt, and older generations preserved but not selected', () => {
    const r1 = parseRuntime(mkRuntime({ runtimeId: 'r1', generation: 2, startedAt: 100, updatedAt: 900 })).public;
    const r2 = parseRuntime(mkRuntime({ runtimeId: 'r2', generation: 2, startedAt: 100, updatedAt: 950 })).public;
    const proj = projectSession({ runtimes: [r1, r2], now: 500 });
    assert.equal(proj.sources.get('smart-subagents').runtimeId, 'r2');
  });

  it('selects per source independently (smart + plan)', () => {
    const smart = parseRuntime(mkRuntime({ source: 'smart-subagents', generation: 1 })).public;
    const planRt = parseRuntime(mkRuntime({
      source: 'plan-mode',
      controlToken: undefined,
      generation: 2,
      jobs: undefined,
      startedAt: 50,
    })).public;
    const proj = projectSession({ runtimes: [smart, planRt], now: 5000 });
    assert.equal(proj.sources.get('smart-subagents').runtimeId, smart.runtimeId);
    assert.equal(proj.sources.get('plan-mode').runtimeId, planRt.runtimeId);
    // primary = newest across sources by the same comparator (generation first)
    assert.equal(proj.primary.runtimeId, planRt.runtimeId);
  });

  it('binds jobs only to the selected smart runtime + generation', () => {
    const rt = parseRuntime(mkRuntime({ generation: 2 })).public;
    const agents = parseAgents(mkAgents({
      generation: 2,
      jobs: [mkJob({ id: 'j1', status: 'running' })],
    }));
    const oldAgents = parseAgents(mkAgents({
      generation: 1,
      jobs: [mkJob({ id: 'jOld', status: 'running' })],
    }));
    const otherRtAgents = parseAgents(mkAgents({
      runtimeId: 'rt-other',
      jobs: [mkJob({ id: 'jOther', status: 'running' })],
    }));
    const proj = projectSession({
      runtimes: [rt],
      agentsList: [agents, oldAgents, otherRtAgents],
      now: 5000,
    });
    assert.equal(proj.jobs.length, 1);
    assert.equal(proj.jobs[0].id, 'j1');
  });

  it('never combines jobs across generations', () => {
    const rt = parseRuntime(mkRuntime({ generation: 3 })).public;
    const gen3 = parseAgents(mkAgents({ generation: 3, jobs: [mkJob({ id: 'a', status: 'completed' })] }));
    const gen2 = parseAgents(mkAgents({ generation: 2, jobs: [mkJob({ id: 'b', status: 'running' })] }));
    const proj = projectSession({ runtimes: [rt], agentsList: [gen3, gen2], now: 5000 });
    assert.deepEqual(proj.jobs.map(j => j.id), ['a']);
    assert.equal(proj.activeCount, 0);
  });

  it('binds plan chip only to the selected plan-mode runtime + generation', () => {
    const planRt = parseRuntime(mkRuntime({
      source: 'plan-mode',
      controlToken: undefined,
      jobs: undefined,
      generation: 2,
      runtimeId: 'rt-plan',
    })).public;
    const smart = parseRuntime(mkRuntime({ generation: 1 })).public;
    const plan2 = parsePlan(mkPlan({ runtimeId: 'rt-plan', generation: 2, state: 'active', reason: 'user asked', since: 700 }));
    const plan1 = parsePlan(mkPlan({ runtimeId: 'rt-plan', generation: 1, state: 'active', reason: 'stale gen', since: 100 }));
    const proj = projectSession({
      runtimes: [smart, planRt],
      plans: [plan2, plan1],
      now: 5000,
    });
    assert.equal(proj.plan.generation, 2);
    assert.equal(proj.plan.reason, 'user asked');
    assert.equal(proj.plan.since, 700);
  });

  it('plan chip state/reason/since are exact', () => {
    const planRt = parseRuntime(mkRuntime({
      source: 'plan-mode',
      controlToken: undefined,
      jobs: undefined,
    })).public;
    const plan = parsePlan(mkPlan({ state: 'inactive', reason: '', since: 0 }));
    const proj = projectSession({ runtimes: [planRt], plans: [plan], now: 5000 });
    assert.equal(proj.plan.state, 'inactive');
    assert.equal(proj.plan.reason, '');
    assert.equal(proj.plan.since, 0);
  });

  it('sorts active jobs first, newest first, then queue position', () => {
    const rt = parseRuntime(mkRuntime()).public;
    const agents = parseAgents(mkAgents({
      jobs: [
        mkJob({ id: 'j1', status: 'completed', startedAt: 500, finishedAt: 600 }),
        mkJob({ id: 'j2', status: 'running', startedAt: 100 }),
        mkJob({ id: 'j3', status: 'queued', createdAt: 90, startedAt: undefined }),
        mkJob({ id: 'j4', status: 'failed', startedAt: 200 }),
        mkJob({ id: 'j5', status: 'running', startedAt: 300, stopping: true }),
      ],
    }));

    const proj = projectSession({ runtimes: [rt], agentsList: [agents], now: 5000 });
    const ids = proj.jobs.map(j => j.id);
    // active group: j5 (startedAt 300), j2 (startedAt 100), j3 (queued, no startedAt)
    assert.deepEqual(ids.slice(0, 3), ['j5', 'j2', 'j3']);
    // terminal group by startedAt desc: j1 (500), j4 (200)
    assert.deepEqual(ids.slice(3), ['j1', 'j4']);
  });

  it('activeCount/badge include routing/queued/running/stopping; terminal excluded', () => {
    const rt = parseRuntime(mkRuntime()).public;
    const agents = parseAgents(mkAgents({
      jobs: [
        mkJob({ id: 'j1', status: 'running', startedAt: 100 }),
        mkJob({ id: 'j2', status: 'queued', createdAt: 200 }),
        mkJob({ id: 'j3', status: 'routing', createdAt: 300 }),
        mkJob({ id: 'j4', status: 'running', stopping: true, startedAt: 400 }),
        mkJob({ id: 'j5', status: 'completed', startedAt: 50, finishedAt: 300 }),
        mkJob({ id: 'j6', status: 'stopped', startedAt: 60, finishedAt: 400 }),
      ],
    }));

    const proj = projectSession({ runtimes: [rt], agentsList: [agents], now: 5000 });
    assert.equal(proj.activeCount, 4);
    assert.equal(proj.badge, '4');
  });

  it('binds only the selected background runtime and includes managed runs in the total badge', () => {
    const smart = parseRuntime(mkRuntime()).public;
    const agents = parseAgents(mkAgents({ jobs: [mkJob({ id: 'smart-job', status: 'running' })] }));
    const backgroundRuntime = parseRuntime(mkRuntime({
      source: 'background-tasks',
      runtimeId: 'bg1',
      generation: 1,
      controlToken: undefined,
      jobs: { total: 1, active: 1 },
    })).public;
    const staleBackgroundRuntime = parseRuntime(mkRuntime({
      source: 'background-tasks',
      runtimeId: 'bg-old',
      generation: 0,
      controlToken: undefined,
    })).public;
    const current = parseBackgroundTasks(mkBackground());
    const stale = parseBackgroundTasks(mkBackground({ runtimeId: 'bg-old', generation: 0, revision: 99, tasks: [], runs: [] }));
    const proj = projectSession({
      runtimes: [smart, backgroundRuntime, staleBackgroundRuntime],
      agentsList: [agents],
      backgroundsList: [stale, current],
      now: 5000,
    });
    assert.equal(proj.activeCount, 1);
    assert.equal(proj.backgroundActiveCount, 1);
    assert.equal(proj.totalActiveCount, 2);
    assert.equal(proj.badge, '2');
    assert.equal(proj.background.revision, 3);
    assert.deepEqual(proj.backgroundTasks.map(task => task.id), ['run', 'next']);
    assert.deepEqual(proj.backgroundRuns.map(run => run.id), ['bg-run-1']);
  });

  it('badge is empty when no active jobs', () => {
    const rt = parseRuntime(mkRuntime()).public;
    const agents = parseAgents(mkAgents({
      jobs: [mkJob({ id: 'j1', status: 'completed', startedAt: 50, finishedAt: 300 })],
    }));
    const proj = projectSession({ runtimes: [rt], agentsList: [agents], now: 5000 });
    assert.equal(proj.activeCount, 0);
    assert.equal(proj.badge, '');
  });

  it('returns idle status when no runtimes', () => {
    const proj = projectSession({ now: 5000 });
    assert.equal(proj.status, 'idle');
    assert.equal(proj.primary, null);
  });

  it('status reflects stale runtime with missing heartbeat (never active)', () => {
    const rt = parseRuntime(mkRuntime({ heartbeatAt: undefined })).public;
    const proj = projectSession({ runtimes: [rt], now: 999999 });
    assert.equal(proj.status, 'stale');
  });

  it('status reflects stale runtime', () => {
    const rt = parseRuntime(mkRuntime({ heartbeatAt: 1000 })).public;
    const proj = projectSession({ runtimes: [rt], now: 1000 + HEARTBEAT_STALE_MS + 1 });
    assert.equal(proj.status, 'stale');
  });

  it('status reflects shutdown runtime even with fresh heartbeat', () => {
    const rt = parseRuntime(mkRuntime({ state: 'shutdown', heartbeatAt: 5000 })).public;
    const proj = projectSession({ runtimes: [rt], now: 6000 });
    assert.equal(proj.status, 'shutdown');
  });

  it('requires finite now', () => {
    assert.throws(() => projectSession({ now: NaN }), /now must be finite/);
  });

  it('annotates timing on jobs', () => {
    const rt = parseRuntime(mkRuntime()).public;
    const agents = parseAgents(mkAgents({
      jobs: [mkJob({ id: 'j1', status: 'running', createdAt: 500, startedAt: 1000, lastProgressAt: 4000 })],
    }));
    const proj = projectSession({ runtimes: [rt], agentsList: [agents], now: 5000 });
    assert.equal(proj.jobs[0].timing.elapsed, 4000);
    assert.equal(proj.jobs[0].timing.queueAge, 4500);
    assert.equal(proj.jobs[0].timing.progressAge, 1000);
    assert.equal(proj.jobs[0].timing.timedOut, false);
  });
});

// ========================================================================
// newestRuntimePerSource
// ========================================================================

describe('newestRuntimePerSource', () => {
  it('groups by source and keeps the newest per source', () => {
    const a1 = parseRuntime(mkRuntime({ runtimeId: 'r1', generation: 1 })).public;
    const a2 = parseRuntime(mkRuntime({ runtimeId: 'r2', generation: 2 })).public;
    const p1 = parseRuntime(mkRuntime({ source: 'plan-mode', controlToken: undefined, jobs: undefined, runtimeId: 'r3' })).public;
    const map = newestRuntimePerSource([a1, a2, p1]);
    assert.equal(map.get('smart-subagents').runtimeId, 'r2');
    assert.equal(map.get('plan-mode').runtimeId, 'r3');
  });

  it('empty input gives empty map', () => {
    assert.equal(newestRuntimePerSource([]).size, 0);
  });
});

// ========================================================================
// Control envelope
// ========================================================================

describe('buildControlEnvelope', () => {
  const cap = Object.freeze({
    sessionId: 'sess1',
    runtimeId: 'rt1',
    generation: 3,
    controlToken: 'secret-token',
  });

  it('builds stop_one envelope with the exact registry.ts top-level protocol', () => {
    const env = buildControlEnvelope({
      capability: cap,
      action: 'stop_one',
      jobId: 'job1',
      requestId: 'req1',
      ttlMs: 5000,
      now: 10000,
      runtimeStatus: 'active',
    });
    assert.deepEqual(Object.keys(env).sort(), [
      'action', 'controlToken', 'createdAt', 'expiresAt', 'generation',
      'jobId', 'requestId', 'runtimeId', 'schemaVersion', 'sessionId',
    ]);
    assert.equal(env.schemaVersion, 1);
    assert.equal(env.sessionId, 'sess1');
    assert.equal(env.runtimeId, 'rt1');
    assert.equal(env.generation, 3);
    assert.equal(env.controlToken, 'secret-token');
    assert.equal(env.action, 'stop_one');
    assert.equal(env.jobId, 'job1');
    assert.equal(env.requestId, 'req1');
    assert.equal(env.createdAt, 10000);
    assert.equal(env.expiresAt, 15000);
    // No invented envelopeId/identity/ttlMs extras
    assert.equal(env.envelopeId, undefined);
    assert.equal(env.identity, undefined);
    assert.equal(env.ttlMs, undefined);
  });

  it('builds stop_all envelope without jobId', () => {
    const env = buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: 3000,
      now: 10000,
      runtimeStatus: 'active',
    });
    assert.equal(env.action, 'stop_all');
    assert.equal(env.jobId, undefined);
    assert.equal(env.expiresAt, 13000);
  });

  it('generates requestId if not supplied', () => {
    const env = buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    });
    assert.ok(env.requestId);
    assert.ok(isSafeId(env.requestId));
  });

  it('validates explicit requestId as a safe id', () => {
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      requestId: '../bad',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    }), /requestId/);
  });

  it('refuses missing capability', () => {
    assert.throws(() => buildControlEnvelope({
      capability: null,
      action: 'stop_all',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    }), /missing capability/);
  });

  it('refuses shutdown runtime', () => {
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'shutdown',
    }), /shutdown/);
  });

  it('refuses stale runtime', () => {
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'stale',
    }), /stale/);
  });

  it('refuses TTL > 10s (browser bound; backend allows 60s)', () => {
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: 10001,
      now: 10000,
      runtimeStatus: 'active',
    }), /exceeds max/);
  });

  it('accepts TTL = 10s exactly', () => {
    const env = buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: CONTROL_MAX_TTL_MS,
      now: 10000,
      runtimeStatus: 'active',
    });
    assert.equal(env.expiresAt - env.createdAt, CONTROL_MAX_TTL_MS);
  });

  it('refuses unknown action', () => {
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'pause',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    }), /unknown action/);
  });

  it('stop_one requires exact safe jobId', () => {
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'stop_one',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    }), /exact safe job id/);
    assert.throws(() => buildControlEnvelope({
      capability: cap,
      action: 'stop_one',
      jobId: '../bad',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    }), /exact safe job id/);
  });

  it('envelope is frozen', () => {
    const env = buildControlEnvelope({
      capability: cap,
      action: 'stop_all',
      ttlMs: 1000,
      now: 10000,
      runtimeStatus: 'active',
    });
    assert.throws(() => { env.action = 'other'; }, /Cannot assign|read only|frozen/i);
  });
});

// ========================================================================
// matchAck
// ========================================================================

describe('matchAck', () => {
  const cap = Object.freeze({
    sessionId: 'sess1',
    runtimeId: 'rt1',
    generation: 0,
    controlToken: 'secret-token',
  });

  function envelope(action = 'stop_one', jobId = 'j1') {
    return buildControlEnvelope({
      capability: cap,
      action,
      jobId,
      requestId: 'req1',
      ttlMs: 5000,
      now: 10000,
      runtimeStatus: 'active',
    });
  }

  it('matches correct ack (top-level fields + action + jobId)', () => {
    const env = envelope();
    const ack = parseAck(mkAck({ requestId: 'req1', action: 'stop_one', jobId: 'j1' }));
    assert.equal(matchAck(ack, env), true);
  });

  it('matches rejected ack without action/jobId (parse-failure acks)', () => {
    const env = envelope();
    const ack = parseAck(mkAck({ action: undefined, jobId: undefined, accepted: false }));
    assert.equal(matchAck(ack, env), true);
  });

  it('rejects ack with wrong sessionId', () => {
    const ack = parseAck(mkAck({ sessionId: 'OTHER' }));
    assert.equal(matchAck(ack, envelope()), false);
  });

  it('rejects ack with wrong runtimeId', () => {
    const ack = parseAck(mkAck({ runtimeId: 'OTHER' }));
    assert.equal(matchAck(ack, envelope()), false);
  });

  it('rejects ack with wrong generation', () => {
    const ack = parseAck(mkAck({ generation: 1 }));
    assert.equal(matchAck(ack, envelope()), false);
  });

  it('rejects ack with wrong requestId', () => {
    const ack = parseAck(mkAck({ requestId: 'reqWRONG' }));
    assert.equal(matchAck(ack, envelope()), false);
  });

  it('rejects ack with wrong action', () => {
    const ack = parseAck(mkAck({ action: 'stop_all', jobId: undefined }));
    assert.equal(matchAck(ack, envelope()), false);
  });

  it('rejects ack with wrong jobId', () => {
    const ack = parseAck(mkAck({ jobId: 'OTHER' }));
    assert.equal(matchAck(ack, envelope()), false);
  });

  it('returns false for null inputs', () => {
    assert.equal(matchAck(null, {}), false);
    assert.equal(matchAck({}, null), false);
  });
});
