// test-activity-view-model.mjs — node --test suite for activity-view-model.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRuntime, parseAgents, parsePlan, parseBackgroundTasks, COMPLETED_TASK_HOLD_MS, HEARTBEAT_STALE_MS } from './activity-schema.js';
import {
  buildViewModel, completedItemVisible, computeJobDisplayStatus, formatDuration, formatRelative,
} from './activity-view-model.js';

// ---- backend-shaped record helpers (mirror schema contract) ----

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
    jobs: { total: 0, active: 0 },
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
    generation: 0,
    revision: 4,
    updatedAt: 5000,
    tasks: [
      { id: 'run', name: 'run', status: 'in_progress', position: 0, updatedAt: 4500, runId: 'bg-run-1' },
      { id: 'next', name: 'next', status: 'pending', position: 1, updatedAt: 4500 },
    ],
    runs: [
      { id: 'bg-run-1', taskId: 'run', name: 'run', status: 'running', stopping: false, createdAt: 4000, startedAt: 4100, lastOutputAt: 4900, lastProgressAt: 4950, lastHeartbeatAt: 4990, healthStatus: 'healthy', healthDeadlineAt: 7000, timeoutAt: 20_000 },
    ],
    ...overrides,
  };
}

function sessionState({ sessionId = 'sess1', runtimes = [], agentsList = [], plans = [], backgroundsList = [], capability = true, overrides = {} } = {}) {
  const capabilities = {};
  for (const r of runtimes) {
    if (r.source === 'smart-subagents' && capability) {
      capabilities[`${sessionId}/${r.runtimeId}`] = {
        sessionId, runtimeId: r.runtimeId, generation: r.generation, controlToken: 'secret-token-abc',
      };
    }
  }
  return {
    cacheKey: 'm1::w1',
    disconnected: false,
    snapshot: {
      sessions: {
        [sessionId]: { runtimes, agentsList, plans, backgroundsList },
      },
    },
    capabilities,
    pendingRequests: {},
    diagnostics: [],
    lastSuccessAt: 1500,
    ...overrides,
  };
}

// ============================================================================
// formatting helpers
// ============================================================================

describe('formatDuration', () => {
  it('formats seconds/minutes/hours', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(12_000), '12s');
    assert.equal(formatDuration(61_000), '1m 01s');
    assert.equal(formatDuration(59_000), '59s');
    assert.equal(formatDuration(3_723_000), '1h 02m 03s');
  });

  it('is stable for non-finite/negative input', () => {
    assert.equal(formatDuration(NaN), '0s');
    assert.equal(formatDuration(-5), '0s');
    assert.equal(formatDuration(undefined), '0s');
  });

  it('ticks cleanly across a local 1s boundary', () => {
    assert.equal(formatDuration(59_999), '59s');
    assert.equal(formatDuration(60_000), '1m 00s');
    assert.equal(formatDuration(60_999), '1m 00s');
  });
});

describe('formatRelative', () => {
  const now = 10_000;
  it('formats past/future/now', () => {
    assert.equal(formatRelative(now - 5000, now), '5s ago');
    assert.equal(formatRelative(now - 3 * 60_000, now), '3m ago');
    assert.equal(formatRelative(now + 10_000, now), 'in 10s');
    assert.equal(formatRelative(now, now), 'just now');
    assert.equal(formatRelative(now - 500, now), 'just now');
  });

  it('returns empty for non-finite', () => {
    assert.equal(formatRelative(NaN, now), '');
    assert.equal(formatRelative(now, undefined), '');
  });
});

// ============================================================================
// computeJobDisplayStatus
// ============================================================================

describe('computeJobDisplayStatus', () => {
  const running = mkJob({ status: 'running' });
  const queued = mkJob({ status: 'queued', startedAt: undefined });
  const completed = mkJob({ status: 'completed', finishedAt: 500 });

  it('passes through the six backend statuses when fresh', () => {
    for (const status of ['routing', 'queued', 'running', 'completed', 'failed', 'stopped']) {
      const job = mkJob({ status });
      assert.equal(computeJobDisplayStatus(job, 'active'), status, status);
    }
  });

  it('stopping flag displays stopping', () => {
    assert.equal(computeJobDisplayStatus(mkJob({ status: 'running', stopping: true }), 'active'), 'stopping');
  });

  it('pending stop displays stopping', () => {
    assert.equal(computeJobDisplayStatus(running, 'active', true), 'stopping');
  });

  it('an active job whose smart runtime is stale displays stale', () => {
    assert.equal(computeJobDisplayStatus(running, 'stale'), 'stale');
    assert.equal(computeJobDisplayStatus(queued, 'stale'), 'stale');
  });

  it('a terminal job keeps its backend status even when the runtime is stale', () => {
    assert.equal(computeJobDisplayStatus(completed, 'stale'), 'completed');
  });

  it('a terminal job never displays stopping', () => {
    assert.equal(computeJobDisplayStatus(completed, 'active', true), 'completed');
  });

  it('null job -> idle', () => {
    assert.equal(computeJobDisplayStatus(null, 'active'), 'idle');
  });
});

// ============================================================================
// buildViewModel — session grouping/sorting/highlighting
// ============================================================================

describe('buildViewModel — grouping and sorting', () => {
  function stateFor(id, jobStatus, extra = {}) {
    const rt = parseRuntime(mkRuntime({ sessionId: id, runtimeId: `rt-${id}`, heartbeatAt: 5000 })).public;
    const cap = parseRuntime(mkRuntime({ sessionId: id, runtimeId: `rt-${id}`, heartbeatAt: 5000 })).capability;
    const agents = parseAgents(mkAgents({
      sessionId: id,
      runtimeId: `rt-${id}`,
      jobs: jobStatus ? [mkJob({ id: `job-${id}`, status: jobStatus })] : [],
    }));
    return {
      snapshot: {
        sessions: {
          [id]: { runtimes: [rt], agentsList: [agents], plans: [] },
        },
      },
      capabilities: { [`${id}/rt-${id}`]: cap },
      pendingRequests: {},
      ...extra,
    };
  }

  it('sorts active first, then selected, then id; never hides sessions', () => {
    const state = {
      snapshot: {
        sessions: {
          'sess-b': stateFor('sess-b', 'completed').snapshot.sessions['sess-b'],
          'sess-a': stateFor('sess-a', 'running').snapshot.sessions['sess-a'],
          'sess-c': stateFor('sess-c', 'running').snapshot.sessions['sess-c'],
          'sess-d': stateFor('sess-d', 'completed').snapshot.sessions['sess-d'],
        },
      },
      capabilities: {
        'sess-a/rt-sess-a': stateFor('sess-a', 'running').capabilities['sess-a/rt-sess-a'],
        'sess-b/rt-sess-b': stateFor('sess-b', 'completed').capabilities['sess-b/rt-sess-b'],
        'sess-c/rt-sess-c': stateFor('sess-c', 'running').capabilities['sess-c/rt-sess-c'],
        'sess-d/rt-sess-d': stateFor('sess-d', 'completed').capabilities['sess-d/rt-sess-d'],
      },
      pendingRequests: {},
    };

    // selected = sess-d (inactive) — it must sort after all active sessions
    // but before its inactive sibling (sess-b) by selected-first rule.
    const view = buildViewModel(state, { id: 'sess-d' }, 6000);
    const order = view.sessions.map((s) => s.sessionId);
    assert.deepEqual(order, ['sess-a', 'sess-c', 'sess-d', 'sess-b']);
    assert.equal(view.sessions.length, 4); // nothing hidden
  });

  it('total badge sums active jobs across sessions', () => {
    const a = stateFor('sess-a', 'running');
    const c = stateFor('sess-c', 'running');
    const state = {
      snapshot: { sessions: { 'sess-a': a.snapshot.sessions['sess-a'], 'sess-c': c.snapshot.sessions['sess-c'] } },
      capabilities: { 'sess-a/rt-sess-a': a.capabilities['sess-a/rt-sess-a'], 'sess-c/rt-sess-c': c.capabilities['sess-c/rt-sess-c'] },
      pendingRequests: {},
    };
    const view = buildViewModel(state, null, 6000);
    assert.equal(view.totalActive, 2);
    assert.equal(view.badge, '2');
  });

  it('selectedSession highlighting is defensive and never throws', () => {
    const a = stateFor('sess-a', 'running');
    const state = {
      snapshot: { sessions: { 'sess-a': a.snapshot.sessions['sess-a'] } },
      capabilities: { 'sess-a/rt-sess-a': a.capabilities['sess-a/rt-sess-a'] },
      pendingRequests: {},
    };
    // Ambiguous selection -> no highlight, but session still present.
    const ambiguous = buildViewModel(state, { id: 'sess-a', sessionId: 'sess-other' }, 6000);
    assert.equal(ambiguous.sessions[0].selected, false);
    const ok = buildViewModel(state, 'sess-a', 6000);
    assert.equal(ok.sessions[0].selected, true);
    // Non-string garbage selection is ignored.
    assert.equal(buildViewModel(state, 42, 6000).sessions[0].selected, false);
  });
});

// ============================================================================
// buildViewModel — statuses, plan chip, disconnected
// ============================================================================

describe('buildViewModel — statuses and plan', () => {
  it('derives job display statuses: stale, stopping, queued', () => {
    const staleRt = parseRuntime(mkRuntime({ heartbeatAt: undefined })).public; // never fresh
    const agents = parseAgents(mkAgents({
      jobs: [
        mkJob({ id: 'run', status: 'running', startedAt: 300 }),
        mkJob({ id: 'stop', status: 'running', startedAt: 400, stopping: true }),
        mkJob({ id: 'q', status: 'queued', startedAt: undefined, queuePosition: 2 }),
      ],
    }));
    const state = sessionState({ runtimes: [staleRt], agentsList: [agents], capability: false });
    const view = buildViewModel(state, null, 1_000_000);
    const byId = Object.fromEntries(view.sessions[0].jobs.map((j) => [j.id, j]));
    assert.equal(byId.run.status, 'stale');
    assert.equal(byId.stop.status, 'stopping'); // stopping wins over stale
    assert.equal(byId.q.status, 'stale'); // active queued job on stale runtime
    assert.equal(byId.q.queuePosition, 2); // queued position preserved
    assert.equal(byId.q.backendStatus, 'queued');
  });

  it('preserves job field set and timing', () => {
    const rt = parseRuntime(mkRuntime({ heartbeatAt: 5000 })).public;
    const cap = parseRuntime(mkRuntime({ heartbeatAt: 5000 })).capability;
    const agents = parseAgents(mkAgents({
      jobs: [mkJob({
        id: 'j1', status: 'running', createdAt: 500, startedAt: 1000, lastProgressAt: 4000,
        model: 'openai-codex/gpt-5', modelName: 'gpt-5', providerName: 'OpenAI', thinking: 'high',
        context: 'isolated', permission: 'read-only', progress: ['p1'], changedFiles: ['a.js'],
        resultSummary: 'done', logPath: '/tmp/x.json',
      })],
    }));
    const state = {
      snapshot: { sessions: { sess1: { runtimes: [rt], agentsList: [agents], plans: [] } } },
      capabilities: { 'sess1/rt1': cap },
      pendingRequests: {},
    };
    const view = buildViewModel(state, null, 5000);
    const job = view.sessions[0].jobs[0];
    assert.equal(job.model, 'openai-codex/gpt-5');
    assert.equal(job.modelName, 'gpt-5');
    assert.equal(job.providerName, 'OpenAI');
    assert.equal(job.thinking, 'high');
    assert.equal(job.context, 'isolated');
    assert.equal(job.permission, 'read-only');
    assert.equal(job.elapsed, 4000);
    assert.equal(job.queueAge, 4500);
    assert.equal(job.progressAge, 1000);
    assert.deepEqual(job.progress, ['p1']);
    assert.deepEqual(job.changedFiles, ['a.js']);
    assert.equal(job.resultSummary, 'done');
    assert.equal(job.logPath, '/tmp/x.json');
    assert.equal(job.canStop, true);
  });

  it('projects dynamic main-agent task plan and managed run timing into the total badge', () => {
    const backgroundRt = parseRuntime(mkRuntime({
      source: 'background-tasks', runtimeId: 'bg1', controlToken: undefined, heartbeatAt: 5000,
      jobs: { total: 1, active: 1 },
    })).public;
    const background = parseBackgroundTasks(mkBackground());
    const state = sessionState({ runtimes: [backgroundRt], backgroundsList: [background], capability: false });
    const view = buildViewModel(state, null, 6000);
    const session = view.sessions[0];
    assert.equal(view.totalActive, 1);
    assert.equal(view.badge, '1');
    assert.equal(session.activeCount, 1);
    assert.equal(session.smartActiveCount, 0);
    assert.equal(session.backgroundActiveCount, 1);
    assert.equal(session.background.revision, 4);
    assert.deepEqual(session.background.tasks.map(task => [task.id, task.status]), [
      ['run', 'in_progress'],
      ['next', 'pending'],
    ]);
    assert.equal(session.background.runs[0].status, 'running');
    assert.equal(session.background.runs[0].elapsed, 1900);
    assert.equal(session.background.runs[0].progressAge, 1050);
    assert.equal(session.background.runs[0].healthStatus, 'healthy');
    assert.equal(session.background.runs[0].healthFailure, null);
    assert.equal(session.background.runs[0].healthDeadlineAt, 7000);
    assert.equal(session.stop, null, 'read-only Web task display has no stop capability');
  });

  it('stale background runtime marks only its active managed runs stale', () => {
    const backgroundRt = parseRuntime(mkRuntime({
      source: 'background-tasks', runtimeId: 'bg1', controlToken: undefined, heartbeatAt: undefined,
    })).public;
    const background = parseBackgroundTasks(mkBackground({ runs: [
      ...mkBackground().runs,
      { id: 'done', taskId: 'next', name: 'done', status: 'completed', createdAt: 1000, startedAt: 1100, finishedAt: 1200 },
    ] }));
    const view = buildViewModel(sessionState({ runtimes: [backgroundRt], backgroundsList: [background], capability: false }), null, 6000);
    const runs = Object.fromEntries(view.sessions[0].background.runs.map(run => [run.id, run]));
    assert.equal(runs['bg-run-1'].status, 'stale');
    assert.equal(runs.done.status, 'completed');
  });

  it('completed tasks and completed runs age out after 60s without affecting active counts', () => {
    const now = 5_000_000;
    const backgroundRt = parseRuntime(mkRuntime({
      source: 'background-tasks', runtimeId: 'bg1', controlToken: undefined, heartbeatAt: now,
      jobs: { total: 4, active: 1 },
    })).public;
    const background = parseBackgroundTasks(mkBackground({
      updatedAt: now,
      tasks: [
        { id: 'recent', name: 'recent', status: 'completed', position: 0, updatedAt: now - COMPLETED_TASK_HOLD_MS + 1 },
        { id: 'expired', name: 'expired', status: 'completed', position: 1, updatedAt: now - COMPLETED_TASK_HOLD_MS },
        { id: 'failed', name: 'failed', status: 'failed', position: 2, updatedAt: 1 },
        { id: 'pending', name: 'pending', status: 'pending', position: 3, updatedAt: 1 },
      ],
      runs: [
        { id: 'run-live', taskId: 'pending', name: 'live', status: 'running', createdAt: now - 1000, startedAt: now - 900 },
        { id: 'run-recent', taskId: 'recent', name: 'recent', status: 'completed', createdAt: 1, startedAt: 2, finishedAt: now - COMPLETED_TASK_HOLD_MS + 1 },
        { id: 'run-expired', taskId: 'expired', name: 'expired', status: 'completed', createdAt: 1, startedAt: 2, finishedAt: now - COMPLETED_TASK_HOLD_MS },
        { id: 'run-failed', taskId: 'failed', name: 'failed', status: 'failed', createdAt: 1, startedAt: 2, finishedAt: 3 },
      ],
    }));
    const view = buildViewModel(sessionState({ runtimes: [backgroundRt], backgroundsList: [background], capability: false }), null, now);
    assert.deepEqual(view.sessions[0].background.tasks.map(task => task.id), ['recent', 'failed', 'pending']);
    assert.deepEqual(view.sessions[0].background.runs.map(run => run.id), ['run-live', 'run-recent', 'run-failed']);
    assert.equal(view.totalActive, 1);
    assert.equal(view.badge, '1');
    assert.equal(completedItemVisible('completed', now + 1000, now), true, 'clock rollback stays visible');
    assert.equal(completedItemVisible('failed', 1, now), true, 'failed is actionable and never auto-hides');
  });

  it('plan chip carries state/reason/since plus independent plan runtime liveness', () => {
    const planRt = parseRuntime(mkRuntime({
      source: 'plan-mode', controlToken: undefined, jobs: undefined, runtimeId: 'rt-plan', heartbeatAt: 5000,
    })).public;
    const plan = parsePlan(mkPlan({ runtimeId: 'rt-plan', state: 'active', reason: 'user asked', since: 700 }));
    const state = sessionState({ runtimes: [planRt], plans: [plan], capability: false });
    const view = buildViewModel(state, null, 6000);
    const chip = view.sessions[0].plan;
    assert.equal(chip.state, 'active');
    assert.equal(chip.reason, 'user asked');
    assert.equal(chip.since, 700);
    assert.equal(chip.runtimeStatus, 'active');
    // plan-only session has no stop owner
    assert.equal(view.sessions[0].stop, null);
    assert.equal(view.sessions[0].smartStatus, 'idle');
  });

  it('plan chip reflects a stale/shutdown plan runtime independently of jobs', () => {
    const planRt = parseRuntime(mkRuntime({
      source: 'plan-mode', controlToken: undefined, jobs: undefined, runtimeId: 'rt-plan', state: 'shutdown',
    })).public;
    const plan = parsePlan(mkPlan({ runtimeId: 'rt-plan', state: 'active', reason: 'was active', since: 700 }));
    const state = sessionState({ runtimes: [planRt], plans: [plan], capability: false });
    const view = buildViewModel(state, null, 1_000_000);
    assert.equal(view.sessions[0].plan.runtimeStatus, 'shutdown');
    assert.equal(view.sessions[0].plan.state, 'active'); // authoritative record state preserved
  });

  it('exposes disconnected and diagnostics', () => {
    const state = sessionState({
      overrides: {
        disconnected: true,
        diagnostics: [{ level: 'error', message: 'boom', at: 100 }],
        lastSuccessAt: 900,
      },
    });
    const view = buildViewModel(state, null, 5000);
    assert.equal(view.disconnected, true);
    assert.equal(view.lastSuccessAt, 900);
    assert.deepEqual(view.diagnostics, [{ level: 'error', message: 'boom', at: 100 }]);
  });

  it('returns an empty render model for null/empty state', () => {
    const view = buildViewModel(null, null, 5000);
    assert.equal(view.disconnected, false);
    assert.equal(view.totalActive, 0);
    assert.equal(view.badge, '');
    assert.deepEqual(view.sessions, []);
  });

  it('throws on non-finite now', () => {
    assert.throws(() => buildViewModel({}, null, NaN), /now must be finite/);
  });
});

// ============================================================================
// buildViewModel — secrecy
// ============================================================================

describe('buildViewModel — secrecy', () => {
  it('never serializes controlToken, PID, task, or full context', () => {
    const rt = parseRuntime(mkRuntime({ heartbeatAt: 5000, pid: 4242 })).public;
    const cap = parseRuntime(mkRuntime({ heartbeatAt: 5000, pid: 4242 })).capability;
    const agents = parseAgents(mkAgents({
      jobs: [mkJob({
        status: 'running',
        task: 'FULL SECRET TASK',          // extra unknown field (parser drops)
        fullContext: 'PARENT CONTEXT',     // extra unknown field
        liveOutput: 'LIVE OUTPUT',         // extra unknown field
      })],
    }));
    const state = {
      snapshot: { sessions: { sess1: { runtimes: [rt], agentsList: [agents], plans: [] } } },
      capabilities: { 'sess1/rt1': cap },  // holds the real token privately
      pendingRequests: {},
    };
    const view = buildViewModel(state, null, 6000);
    const json = JSON.stringify(view);
    assert.ok(!json.includes('secret-token-abc'), 'must not leak control token');
    assert.ok(!json.includes('controlToken'), 'must not expose controlToken key');
    assert.ok(!json.includes('4242'), 'must not leak pid');
    assert.ok(!json.includes('FULL SECRET TASK'), 'must not leak full task');
    assert.ok(!json.includes('PARENT CONTEXT'), 'must not leak full context');
    assert.ok(!json.includes('LIVE OUTPUT'), 'must not leak live output');
  });

  it('stop ownership exposes only safe availability metadata + owner ids', () => {
    const rt = parseRuntime(mkRuntime({ heartbeatAt: 5000, generation: 3 })).public;
    const cap = parseRuntime(mkRuntime({ heartbeatAt: 5000, generation: 3 })).capability;
    const agents = parseAgents(mkAgents({ generation: 3, jobs: [mkJob({ status: 'running' })] }));
    const state = {
      snapshot: { sessions: { sess1: { runtimes: [rt], agentsList: [agents], plans: [] } } },
      capabilities: { 'sess1/rt1': cap },
      pendingRequests: {},
    };
    const view = buildViewModel(state, null, 6000);
    const stop = view.sessions[0].stop;
    assert.deepEqual(Object.keys(stop).sort(), ['available', 'generation', 'reason', 'runtimeId', 'sessionId']);
    assert.equal(stop.reason, null);
    assert.equal(stop.available, true);
    assert.equal(stop.sessionId, 'sess1');
    assert.equal(stop.runtimeId, 'rt1');
    assert.equal(stop.generation, 3);
    assert.ok(!JSON.stringify(view).includes('secret-token-abc'));
  });

  it('stop unavailable when capability missing, stale, or no active jobs', () => {
    const fresh = parseRuntime(mkRuntime({ heartbeatAt: 5000 })).public;
    const agents = parseAgents(mkAgents({ jobs: [mkJob({ status: 'completed', finishedAt: 400 })] }));
    // No capability -> unavailable
    const noCap = {
      snapshot: { sessions: { sess1: { runtimes: [fresh], agentsList: [agents], plans: [] } } },
      capabilities: {},
      pendingRequests: {},
    };
    assert.equal(buildViewModel(noCap, null, 6000).sessions[0].stop.available, false);

    // Stale runtime -> unavailable
    const staleRt = parseRuntime(mkRuntime({ heartbeatAt: 1000 })).public;
    const staleState = {
      snapshot: { sessions: { sess1: { runtimes: [staleRt], agentsList: [parseAgents(mkAgents({ jobs: [mkJob({ status: 'running' })] }))], plans: [] } } },
      capabilities: { 'sess1/rt1': { sessionId: 'sess1', runtimeId: 'rt1', generation: 0, controlToken: 'tok' } },
      pendingRequests: {},
    };
    assert.equal(buildViewModel(staleState, null, 20000).sessions[0].stop.available, false);

    // Heartbeat older than control TTL but younger than the 15s display-stale
    // threshold: visible activity remains, destructive control is disabled.
    const controlOldRt = parseRuntime(mkRuntime({ heartbeatAt: 1000 })).public;
    const controlOldState = {
      snapshot: { sessions: { sess1: { runtimes: [controlOldRt], agentsList: [parseAgents(mkAgents({ jobs: [mkJob({ status: 'running' })] }))], plans: [] } } },
      capabilities: { 'sess1/rt1': { sessionId: 'sess1', runtimeId: 'rt1', generation: 0, controlToken: 'tok' } },
      pendingRequests: {},
    };
    const controlOldView = buildViewModel(controlOldState, null, 12000);
    assert.equal(controlOldView.sessions[0].smartStatus, 'active');
    assert.equal(controlOldView.sessions[0].stop.available, false);
    assert.match(controlOldView.sessions[0].stop.reason, /control request TTL/);

    // No active jobs -> unavailable even with fresh runtime + capability
    const freshAgents = parseAgents(mkAgents({ jobs: [mkJob({ status: 'completed', finishedAt: 400 })] }));
    const noActive = {
      snapshot: { sessions: { sess1: { runtimes: [fresh], agentsList: [freshAgents], plans: [] } } },
      capabilities: { 'sess1/rt1': { sessionId: 'sess1', runtimeId: 'rt1', generation: 0, controlToken: 'tok' } },
      pendingRequests: {},
    };
    assert.equal(buildViewModel(noActive, null, 6000).sessions[0].stop.available, false);
  });
});

// ============================================================================
// buildViewModel — pending requests surface as stopping (never leaked)
// ============================================================================

describe('buildViewModel — pending requests', () => {
  function pendingState(status) {
    const rt = parseRuntime(mkRuntime({ heartbeatAt: 5000 })).public;
    const cap = parseRuntime(mkRuntime({ heartbeatAt: 5000 })).capability;
    const agents = parseAgents(mkAgents({ jobs: [mkJob({ id: 'j1', status: 'running' })] }));
    const envelope = {
      schemaVersion: 1, sessionId: 'sess1', runtimeId: 'rt1', generation: 0,
      controlToken: 'secret-token-abc', requestId: 'req1', action: 'stop_one', jobId: 'j1',
      createdAt: 5000, expiresAt: 10000,
    };
    return {
      snapshot: { sessions: { sess1: { runtimes: [rt], agentsList: [agents], plans: [] } } },
      capabilities: { 'sess1/rt1': cap },
      pendingRequests: {
        'sess1/rt1/req1': {
          sessionId: 'sess1', runtimeId: 'rt1', requestId: 'req1', envelope, status,
          publishedAt: 5000, expiresAt: 10000,
        },
      },
    };
  }

  it('pending stop marks the job stopping', () => {
    const view = buildViewModel(pendingState('pending'), null, 6000);
    assert.equal(view.sessions[0].jobs[0].status, 'stopping');
    assert.equal(view.sessions[0].stopPending, true);
  });

  it('terminal requests no longer mark jobs stopping', () => {
    for (const status of ['accepted', 'rejected', 'timeout']) {
      const view = buildViewModel(pendingState(status), null, 6000);
      assert.equal(view.sessions[0].jobs[0].status, 'running');
      assert.equal(view.sessions[0].stopPending, false);
    }
  });

  it('never serializes the pending envelope token', () => {
    const json = JSON.stringify(buildViewModel(pendingState('pending'), null, 6000));
    assert.ok(!json.includes('secret-token-abc'));
    assert.ok(!json.includes('controlToken'));
    assert.ok(!json.includes('envelope'));
  });
});
