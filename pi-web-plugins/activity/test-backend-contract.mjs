// test-backend-contract.mjs — cross-module contract test.
// Imports the REAL backend writers/builders (TypeScript, type-stripped by
// node >= 23.6) and proves the browser parser/projection/control module
// round-trips against them:
//   - extensions/smart-subagents/web-record.ts (runtime.json + agents.json)
//   - extensions/plan-mode/index.ts (plan-mode.json writer literal)
//   - extensions/web-activity/registry.ts (control request/ack protocol)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildWebAgentsRecord, buildWebRuntimeRecord } from '../../extensions/smart-subagents/web-record.ts';
import { buildControlAck, parseControlRequest, WEB_ACTIVITY_SCHEMA_VERSION } from '../../extensions/web-activity/registry.ts';
import {
  parseRuntime, parseAgents, parsePlan, parseAck, parseJob,
  projectSession, computeStatus, isJobActive,
  buildControlEnvelope, matchAck,
} from './activity-schema.js';

const IDENTITY = { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' };

// ---------------------------------------------------------------------------
// runtime.json round-trip (smart-subagents)
// ---------------------------------------------------------------------------

describe('backend contract — runtime records', () => {
  it('parser accepts buildWebRuntimeRecord output (active smart runtime)', () => {
    const record = buildWebRuntimeRecord(
      IDENTITY,
      'active',
      { startedAt: 1000, total: 3, active: 2 },
      5000,
    );
    assert.equal(record.source, 'smart-subagents');
    assert.equal(record.schemaVersion, WEB_ACTIVITY_SCHEMA_VERSION);

    const { public: pub, capability } = parseRuntime(record);
    assert.equal(pub.sessionId, 'sess-1');
    assert.equal(pub.runtimeId, 'rt-1');
    assert.equal(pub.generation, 2);
    assert.equal(pub.source, 'smart-subagents');
    assert.equal(pub.state, 'active');
    assert.equal(pub.startedAt, 1000);
    assert.equal(pub.updatedAt, 5000);
    assert.equal(pub.heartbeatAt, 5000);
    assert.deepEqual(pub.jobs, { total: 3, active: 2 });
    // Token stays in the private capability, never the public projection.
    assert.equal(pub.controlToken, undefined);
    assert.ok(capability);
    assert.equal(capability.controlToken, 'tok-1');
    assert.equal(capability.generation, 2);
  });

  it('parser accepts buildWebRuntimeRecord output (shutdown smart runtime)', () => {
    const record = buildWebRuntimeRecord(
      IDENTITY,
      'shutdown',
      { startedAt: 1000, total: 0, active: 0 },
      9000,
    );
    const { public: pub } = parseRuntime(record);
    assert.equal(pub.state, 'shutdown');
    assert.equal(computeStatus(pub, 9000), 'shutdown'); // terminal even though heartbeat is fresh
  });

  it('parser accepts the exact plan-mode runtime writer literal', () => {
    // Verbatim from extensions/plan-mode/index.ts writeRuntimeRecord.
    const record = {
      schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
      source: 'plan-mode',
      sessionId: 'sess-1',
      runtimeId: 'rt-plan',
      generation: 1,
      state: 'active',
      startedAt: 1000,
      updatedAt: 5000,
      heartbeatAt: 5000,
    };
    const { public: pub, capability } = parseRuntime(record);
    assert.equal(pub.source, 'plan-mode');
    assert.equal(pub.state, 'active');
    assert.equal(pub.heartbeatAt, 5000);
    assert.equal(capability, null); // no token, no control capability

    // Shutdown variant: heartbeatAt omitted by the writer.
    const shutdownRecord = { ...record, state: 'shutdown' };
    delete shutdownRecord.heartbeatAt;
    const shutdownParsed = parseRuntime(shutdownRecord);
    assert.equal(shutdownParsed.public.heartbeatAt, null);
    assert.equal(computeStatus(shutdownParsed.public, 100_000), 'shutdown');
  });

  it('rejects a smart runtime record whose generation is not a non-negative integer', () => {
    const record = buildWebRuntimeRecord(
      IDENTITY,
      'active',
      { startedAt: 1000, total: 0, active: 0 },
      5000,
    );
    record.generation = -1;
    assert.throws(() => parseRuntime(record), /generation/);
  });
});

// ---------------------------------------------------------------------------
// agents.json round-trip (smart-subagents)
// ---------------------------------------------------------------------------

describe('backend contract — agents records', () => {
  function job(id, overrides = {}) {
    return {
      id,
      name: `job-${id}`,
      status: 'running',
      createdAt: 1000,
      startedAt: 2000,
      timeoutAt: 2_000_000,
      route: {
        modelRef: 'openai-codex/gpt-5.4-mini',
        modelName: 'gpt-5.4-mini',
        providerName: 'OpenAI Codex',
        effort: 'low',
        contextMode: 'isolated',
        permission: 'read-only',
      },
      progress: [],
      changedFiles: [],
      output: 'done',
      error: undefined,
      logPath: '/tmp/x/result.json',
      ...overrides,
    };
  }

  it('parser accepts buildWebAgentsRecord output with every lifecycle status', () => {
    const record = buildWebAgentsRecord(
      [
        job('routing', { status: 'routing' }),
        job('queued', { status: 'queued' }),
        job('running'),
        job('completed', { status: 'completed', finishedAt: 5000 }),
        job('failed', { status: 'failed', finishedAt: 6000, error: 'boom' }),
        job('stopped', { status: 'stopped', finishedAt: 7000 }),
      ],
      ['queued'],
      IDENTITY,
      9999,
    );
    const parsed = parseAgents(record);
    assert.equal(parsed.sessionId, 'sess-1');
    assert.equal(parsed.runtimeId, 'rt-1');
    assert.equal(parsed.generation, 2);
    assert.equal(parsed.updatedAt, 9999);
    assert.deepEqual(parsed.jobs.map(j => j.status), [
      'routing', 'queued', 'running', 'completed', 'failed', 'stopped',
    ]);

    const [routing, queued, running] = parsed.jobs;
    assert.equal(routing.queuePosition, undefined);
    assert.equal(queued.queuePosition, 1);
    assert.equal(running.stopping, false);
  });

  it('projection counts backend active statuses and terminal statuses correctly', () => {
    const record = buildWebAgentsRecord(
      [
        job('a', { status: 'routing' }),
        job('b', { status: 'queued' }),
        job('c', { status: 'running', stopRequest: 'user' }),
        job('d', { status: 'completed', finishedAt: 5000 }),
        job('e', { status: 'failed', finishedAt: 6000 }),
        job('f', { status: 'stopped', finishedAt: 7000 }),
      ],
      ['b'],
      IDENTITY,
      9999,
    );
    const agents = parseAgents(record);
    assert.equal(agents.jobs.find(j => j.id === 'c').stopping, true);

    const runtime = buildWebRuntimeRecord(
      IDENTITY,
      'active',
      { startedAt: 1000, total: 6, active: 3 },
      9999,
    );
    const proj = projectSession({
      runtimes: [parseRuntime(runtime).public],
      agentsList: [agents],
      now: 10_000,
    });
    assert.equal(proj.activeCount, 3); // routing + queued + running(stopping)
    assert.equal(proj.badge, '3');
    assert.equal(proj.jobs.filter(j => isJobActive(j)).length, 3);
  });

  it('never combines jobs across generations', () => {
    const currentRuntime = buildWebRuntimeRecord(
      IDENTITY,
      'active',
      { startedAt: 1000, total: 1, active: 1 },
      9999,
    );
    const staleRuntime = buildWebRuntimeRecord(
      { ...IDENTITY, runtimeId: 'rt-old' },
      'shutdown',
      { startedAt: 500, total: 1, active: 0 },
      2000,
    );
    staleRuntime.generation = 1;
    const currentAgents = parseAgents(buildWebAgentsRecord([job('current')], [], IDENTITY, 9999));
    const staleAgents = parseAgents(buildWebAgentsRecord(
      [job('stale', { status: 'completed', finishedAt: 3000 })],
      [],
      { ...IDENTITY, runtimeId: 'rt-old', generation: 1 },
      2000,
    ));

    const proj = projectSession({
      runtimes: [parseRuntime(currentRuntime).public, parseRuntime(staleRuntime).public],
      agentsList: [currentAgents, staleAgents],
      now: 10_000,
    });
    assert.deepEqual(proj.jobs.map(j => j.id), ['current']);
    assert.equal(proj.activeCount, 1);
  });

  it('parser rejects unknown job status instead of defaulting to running', () => {
    const record = buildWebAgentsRecord([job('x', { status: 'weird-status' })], [], IDENTITY, 9999);
    assert.throws(() => parseAgents(record), /unknown status/);
    assert.throws(() => parseJob(record.jobs[0]), /unknown status/);
  });

  it('an active runtime with a missing heartbeat is never projected fresh', () => {
    const record = buildWebRuntimeRecord(
      IDENTITY,
      'active',
      { startedAt: 1000, total: 0, active: 0 },
      5000,
    );
    delete record.heartbeatAt;
    const { public: pub } = parseRuntime(record);
    assert.equal(pub.heartbeatAt, null);
    assert.equal(computeStatus(pub, 5000), 'stale');
  });
});

// ---------------------------------------------------------------------------
// plan-mode.json round-trip (plan-mode writer literal)
// ---------------------------------------------------------------------------

describe('backend contract — plan record', () => {
  it('parser accepts the exact active plan literal from the plan-mode writer', () => {
    // Verbatim from extensions/plan-mode/index.ts writePlanRecord.
    const record = {
      schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
      sessionId: 'sess-1',
      runtimeId: 'rt-plan',
      generation: 1,
      state: 'active',
      reason: 'user asked for a plan',
      since: 4200,
      updatedAt: 5000,
      heartbeatAt: 5000,
    };
    const plan = parsePlan(record);
    assert.equal(plan.state, 'active');
    assert.equal(plan.reason, 'user asked for a plan');
    assert.equal(plan.since, 4200);
    assert.equal(plan.updatedAt, 5000);
    assert.equal(plan.heartbeatAt, 5000);
  });

  it('parser accepts the exact inactive plan literal from the plan-mode writer', () => {
    // writePlanRecord with inPlanMode=false: reason '', since 0.
    const record = {
      schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
      sessionId: 'sess-1',
      runtimeId: 'rt-plan',
      generation: 1,
      state: 'inactive',
      reason: '',
      since: 0,
      updatedAt: 5000,
      heartbeatAt: 5000,
    };
    const plan = parsePlan(record);
    assert.equal(plan.state, 'inactive');
    assert.equal(plan.reason, '');
    assert.equal(plan.since, 0);
  });
});

// ---------------------------------------------------------------------------
// Control protocol round-trip (registry.ts)
// ---------------------------------------------------------------------------

describe('backend contract — control protocol', () => {
  it('browser envelope is accepted by the backend parseControlRequest', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' },
      action: 'stop_all',
      requestId: 'req-1',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const result = parseControlRequest(env, IDENTITY, { now: 10_100, maxTtlMs: 60_000, maxClockSkewMs: 5000 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.request.requestId, 'req-1');
      assert.equal(result.request.action, 'stop_all');
      assert.equal(result.request.generation, 2);
      assert.equal(result.request.createdAt, 10_000);
      assert.equal(result.request.expiresAt, 15_000);
    }
  });

  it('browser stop_one envelope with jobId is accepted by the backend', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' },
      action: 'stop_one',
      jobId: 'job-9',
      requestId: 'req-2',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const result = parseControlRequest(env, IDENTITY, { now: 10_100, maxTtlMs: 60_000, maxClockSkewMs: 5000 });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.request.jobId, 'job-9');
    }
  });

  it('backend rejects a browser envelope with a mismatched generation (stale token)', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 3, controlToken: 'tok-1' },
      action: 'stop_all',
      requestId: 'req-3',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const result = parseControlRequest(env, IDENTITY, { now: 10_100, maxTtlMs: 60_000, maxClockSkewMs: 5000 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /generation mismatch/);
  });

  it('backend rejects a browser envelope with a mismatched sessionId', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-X', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' },
      action: 'stop_all',
      requestId: 'req-4',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const result = parseControlRequest(env, IDENTITY, { now: 10_100, maxTtlMs: 60_000, maxClockSkewMs: 5000 });
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /sessionId mismatch/);
  });

  it('parser accepts backend buildControlAck output and matchAck verifies it', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' },
      action: 'stop_one',
      jobId: 'job-9',
      requestId: 'req-2',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const ack = buildControlAck(
      { requestId: 'req-2', accepted: true, reason: 'stopped', action: 'stop_one', jobId: 'job-9' },
      IDENTITY,
      10_500,
    );
    const parsed = parseAck(ack);
    assert.equal(parsed.accepted, true);
    assert.equal(parsed.requestId, 'req-2');
    assert.equal(parsed.respondedAt, 10_500);
    assert.equal(parsed.generation, 2);
    assert.equal(matchAck(parsed, env), true);
  });

  it('parser accepts backend rejected ack (no action/jobId) and matchAck verifies it', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' },
      action: 'stop_all',
      requestId: 'req-5',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const ack = buildControlAck(
      { requestId: 'req-5', accepted: false, reason: 'sessionId mismatch' },
      IDENTITY,
      10_500,
    );
    const parsed = parseAck(ack);
    assert.equal(parsed.accepted, false);
    assert.equal(parsed.action, undefined);
    assert.equal(parsed.jobId, undefined);
    assert.equal(matchAck(parsed, env), true);
  });

  it('matchAck rejects an ack whose generation differs from the envelope', () => {
    const env = buildControlEnvelope({
      capability: { sessionId: 'sess-1', runtimeId: 'rt-1', generation: 2, controlToken: 'tok-1' },
      action: 'stop_all',
      requestId: 'req-6',
      ttlMs: 5000,
      now: 10_000,
      runtimeStatus: 'active',
    });
    const ack = buildControlAck(
      { requestId: 'req-6', accepted: true, reason: 'ok', action: 'stop_all' },
      { ...IDENTITY, generation: 9 },
      10_500,
    );
    assert.equal(matchAck(parseAck(ack), env), false);
  });
});
