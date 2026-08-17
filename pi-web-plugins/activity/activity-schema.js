// activity-schema.js — Pure browser ESM schema/projection/control module
// Frozen contract: base .pi/.runtime/pi-web-activity/v1; schemaVersion 1.
// The records below mirror the ACTUAL backend writers:
//   - extensions/smart-subagents/web-record.ts (runtime.json + agents.json)
//   - extensions/plan-mode/index.ts (plan runtime.json + plan-mode.json)
//   - extensions/web-activity/registry.ts (control request/ack protocol)
// Dependency-free.

export const BASE = '.pi/.runtime/pi-web-activity/v1';
export const SCHEMA_VERSION = 1;
export const HEARTBEAT_STALE_MS = 15_000;
export const CONTROL_MAX_TTL_MS = 10_000;
// Heartbeats arrive every 5s. A 10s control window tolerates one delayed beat
// while still expiring requests quickly and before the 15s stale threshold.
export const DEFAULT_CONTROL_TTL_MS = 10_000;
export const DEFAULT_JOB_TIMEOUT_MS = 60_000;
export const MAX_STR = 1024;
export const MAX_ARR = 256;
export const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// Backend sources (strict). Only these extensions write registry records.
export const SOURCE_SMART = 'smart-subagents';
export const SOURCE_PLAN = 'plan-mode';
export const SOURCES = [SOURCE_SMART, SOURCE_PLAN];

// Backend job lifecycle (extensions/smart-subagents: JobStatus).
export const ACTIVE_JOB_STATUSES = ['routing', 'queued', 'running'];
export const TERMINAL_JOB_STATUSES = ['completed', 'failed', 'stopped'];
export const JOB_STATUSES = [...ACTIVE_JOB_STATUSES, ...TERMINAL_JOB_STATUSES];

// ---- Safe IDs -------------------------------------------------------------

export function isSafeId(s) {
  return typeof s === 'string' && SAFE_ID_RE.test(s);
}

export function assertSafeId(s, label = 'id') {
  if (!isSafeId(s)) throw new Error(`invalid safe id (${label}): ${String(s)}`);
  return s;
}

function assertNoTraversal(s, label = 'segment') {
  if (typeof s !== 'string') throw new Error(`${label}: not a string`);
  if (s.indexOf('\0') >= 0) throw new Error(`${label}: contains null byte`);
  if (s === '.' || s === '..') throw new Error(`${label}: dot segment`);
  if (s.startsWith('/') || s.startsWith('\\')) throw new Error(`${label}: absolute`);
  if (s.includes('/') || s.includes('\\')) throw new Error(`${label}: contains separator`);
}

// ---- Path builders --------------------------------------------------------

export function sessionsDir() {
  return `${BASE}/sessions`;
}

export function sessionDir(sessionId) {
  assertSafeId(sessionId, 'sessionId');
  return `${sessionsDir()}/${sessionId}`;
}

export function runtimesDir(sessionId) {
  return `${sessionDir(sessionId)}/runtimes`;
}

export function runtimeDir(sessionId, runtimeId) {
  assertSafeId(sessionId, 'sessionId');
  assertSafeId(runtimeId, 'runtimeId');
  return `${runtimesDir(sessionId)}/${runtimeId}`;
}

export function requestsDir(sessionId, runtimeId) {
  return `${runtimeDir(sessionId, runtimeId)}/requests`;
}

export function requestTempPath(sessionId, runtimeId, reqId) {
  assertSafeId(reqId, 'reqId');
  // The backend request poller ignores dotfiles and files not ending in .json.
  // Keep the staging file both hidden and non-JSON so Stop can execute only
  // after the atomic move publishes the canonical <requestId>.json name.
  return `${requestsDir(sessionId, runtimeId)}/.${reqId}.tmp`;
}

export function requestFinalPath(sessionId, runtimeId, reqId) {
  assertSafeId(reqId, 'reqId');
  return `${requestsDir(sessionId, runtimeId)}/${reqId}.json`;
}

export function acksDir(sessionId, runtimeId) {
  return `${runtimeDir(sessionId, runtimeId)}/acks`;
}

// Backend writes ack files as acks/<requestId>.json (registry.ts ackControl).
export function ackPath(sessionId, runtimeId, requestId) {
  assertSafeId(requestId, 'requestId');
  return `${acksDir(sessionId, runtimeId)}/${requestId}.json`;
}

// ---- Bounded helpers ------------------------------------------------------

function finiteNum(v, name) {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${name}: not finite`);
  }
  return v;
}

function finiteTs(v, name) {
  return finiteNum(v, name);
}

function nonNegInt(v, name) {
  const n = finiteNum(v, name);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name}: not a non-negative integer`);
  return n;
}

function generationOf(v, name = 'generation') {
  return nonNegInt(v, name);
}

function boundStr(v, name, max = MAX_STR) {
  if (typeof v !== 'string') throw new Error(`${name}: not a string`);
  if (v.length > max) throw new Error(`${name}: too long (${v.length} > ${max})`);
  return v;
}

function boundArr(v, name, max = MAX_ARR) {
  if (!Array.isArray(v)) throw new Error(`${name}: not an array`);
  if (v.length > max) throw new Error(`${name}: too long (${v.length} > ${max})`);
  return v;
}

function optionalStr(v, name, max = MAX_STR) {
  if (v == null) return undefined;
  return boundStr(v, name, max);
}

function optionalTs(v, name) {
  if (v == null) return undefined;
  return finiteTs(v, name);
}

function optionalNonNegInt(v, name) {
  if (v == null) return undefined;
  return nonNegInt(v, name);
}

function safeIdOrThrow(v, name) {
  if (!isSafeId(v)) throw new Error(`${name}: unsafe id`);
  return v;
}

function stringArr(v, name, max = MAX_ARR) {
  const arr = boundArr(v, name, max);
  return arr.map((item, i) => boundStr(item, `${name}[${i}]`));
}

// ---- parseRuntime ---------------------------------------------------------
// Backend contract (smart): {schemaVersion, source:'smart-subagents', sessionId,
//   runtimeId, generation, controlToken, state:'active'|'shutdown', startedAt,
//   updatedAt, heartbeatAt, jobs:{total,active}}.
// Backend contract (plan): same minus controlToken/jobs; source 'plan-mode';
//   heartbeatAt only while active.
// Returns { public, capability }. Public projection excludes controlToken/pid.
// Capability is non-null only for smart runtimes (control handshake secret).

export function parseRuntime(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('runtime: not an object');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`runtime: bad schemaVersion ${raw.schemaVersion}`);
  }
  const sessionId = safeIdOrThrow(boundStr(raw.sessionId, 'sessionId', 128), 'sessionId');
  const runtimeId = safeIdOrThrow(boundStr(raw.runtimeId, 'runtimeId', 128), 'runtimeId');
  const generation = generationOf(raw.generation);
  if (typeof raw.source !== 'string' || !SOURCES.includes(raw.source)) {
    throw new Error(`runtime: unknown source ${String(raw.source)}`);
  }
  const source = raw.source;
  if (raw.state !== 'active' && raw.state !== 'shutdown') {
    throw new Error(`runtime: invalid state ${String(raw.state)}`);
  }
  const state = raw.state;
  const startedAt = finiteTs(raw.startedAt, 'startedAt');
  const updatedAt = finiteTs(raw.updatedAt, 'updatedAt');
  // Heartbeat: finite when present; an active runtime without a heartbeat can
  // never be projected fresh (computeStatus maps null heartbeat to stale).
  const heartbeatAt = raw.heartbeatAt == null ? null : finiteTs(raw.heartbeatAt, 'heartbeatAt');

  let jobs = null;
  if (raw.jobs != null) {
    if (typeof raw.jobs !== 'object' || Array.isArray(raw.jobs)) {
      throw new Error('runtime: jobs not an object');
    }
    jobs = {
      total: nonNegInt(raw.jobs.total, 'jobs.total'),
      active: nonNegInt(raw.jobs.active, 'jobs.active'),
    };
  }

  // No identity/kind/createdAt/shutdown object in the backend contract; PID is
  // never exposed or trusted (control binds to session/runtime/generation/token).
  const publicProj = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    source,
    state,
    generation,
    startedAt,
    updatedAt,
    heartbeatAt,
    jobs,
  });

  let capability = null;
  if (source === SOURCE_SMART) {
    if (typeof raw.controlToken !== 'string' || raw.controlToken.length === 0) {
      throw new Error('smart runtime requires controlToken');
    }
    capability = Object.freeze({
      sessionId,
      runtimeId,
      generation,
      controlToken: raw.controlToken,
    });
  }

  return { public: publicProj, capability };
}

// ---- parseAgents / parseJob -------------------------------------------------
// Backend contract (smart-subagents agents.json):
// {schemaVersion, sessionId, runtimeId, generation, updatedAt, jobs:[{id, name,
//   status, stopping, queuePosition, createdAt, startedAt, finishedAt,
//   lastOutputAt, lastProgressAt, timeoutAt, model, modelName, providerName,
//   thinking, context, permission, progress:string[], changedFiles:string[],
//   resultSummary, errorSummary, logPath}]}.
// Lifecycle: routing, queued, running, completed, failed, stopped. Unknown
// statuses are rejected — they must NEVER default to running.

export function parseJob(raw, idx = 0) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`job[${idx}]: not an object`);
  }
  const id = safeIdOrThrow(boundStr(raw.id, `job[${idx}].id`, 128), `job[${idx}].id`);
  const name = boundStr(raw.name, `job[${idx}].name`, MAX_STR);
  const status = raw.status;
  if (typeof status !== 'string' || !JOB_STATUSES.includes(status)) {
    throw new Error(`job[${idx}]: unknown status ${String(status)}`);
  }
  const stopping = raw.stopping === true;
  const queuePosition = optionalNonNegInt(raw.queuePosition, `job[${idx}].queuePosition`);
  if (queuePosition != null && queuePosition < 1) {
    throw new Error(`job[${idx}].queuePosition: must be >= 1`);
  }
  const createdAt = finiteTs(raw.createdAt, `job[${idx}].createdAt`);
  return {
    id,
    name,
    status,
    stopping,
    queuePosition,
    createdAt,
    startedAt: optionalTs(raw.startedAt, `job[${idx}].startedAt`),
    finishedAt: optionalTs(raw.finishedAt, `job[${idx}].finishedAt`),
    lastOutputAt: optionalTs(raw.lastOutputAt, `job[${idx}].lastOutputAt`),
    lastProgressAt: optionalTs(raw.lastProgressAt, `job[${idx}].lastProgressAt`),
    timeoutAt: optionalTs(raw.timeoutAt, `job[${idx}].timeoutAt`),
    model: optionalStr(raw.model, `job[${idx}].model`),
    modelName: optionalStr(raw.modelName, `job[${idx}].modelName`),
    providerName: optionalStr(raw.providerName, `job[${idx}].providerName`),
    thinking: optionalStr(raw.thinking, `job[${idx}].thinking`),
    context: optionalStr(raw.context, `job[${idx}].context`),
    permission: optionalStr(raw.permission, `job[${idx}].permission`),
    progress: stringArr(raw.progress ?? [], `job[${idx}].progress`),
    changedFiles: stringArr(raw.changedFiles ?? [], `job[${idx}].changedFiles`),
    resultSummary: optionalStr(raw.resultSummary, `job[${idx}].resultSummary`, MAX_STR),
    errorSummary: optionalStr(raw.errorSummary, `job[${idx}].errorSummary`, MAX_STR),
    logPath: optionalStr(raw.logPath, `job[${idx}].logPath`),
  };
}

export function parseAgents(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('agents: not an object');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`agents: bad schemaVersion ${raw.schemaVersion}`);
  }
  const sessionId = safeIdOrThrow(boundStr(raw.sessionId, 'sessionId', 128), 'sessionId');
  const runtimeId = safeIdOrThrow(boundStr(raw.runtimeId, 'runtimeId', 128), 'runtimeId');
  const generation = generationOf(raw.generation);
  const updatedAt = finiteTs(raw.updatedAt, 'updatedAt');
  const rawJobs = boundArr(raw.jobs ?? [], 'jobs');
  const jobs = rawJobs.map((j, i) => parseJob(j, i));
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    generation,
    updatedAt,
    jobs,
  };
}

// ---- parsePlan ------------------------------------------------------------
// Backend contract (plan-mode plan-mode.json):
// {schemaVersion, sessionId, runtimeId, generation, state:'active'|'inactive',
//   reason, since, updatedAt, heartbeatAt}. No active boolean, no items.

export function parsePlan(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('plan: not an object');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`plan: bad schemaVersion ${raw.schemaVersion}`);
  }
  const sessionId = safeIdOrThrow(boundStr(raw.sessionId, 'sessionId', 128), 'sessionId');
  const runtimeId = safeIdOrThrow(boundStr(raw.runtimeId, 'runtimeId', 128), 'runtimeId');
  const generation = generationOf(raw.generation);
  if (raw.state !== 'active' && raw.state !== 'inactive') {
    throw new Error(`plan: invalid state ${String(raw.state)}`);
  }
  const state = raw.state;
  const reason = optionalStr(raw.reason, 'reason', MAX_STR) ?? '';
  const since = finiteTs(raw.since, 'since');
  const updatedAt = finiteTs(raw.updatedAt, 'updatedAt');
  const heartbeatAt = raw.heartbeatAt == null ? null : finiteTs(raw.heartbeatAt, 'heartbeatAt');
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    generation,
    state,
    reason,
    since,
    updatedAt,
    heartbeatAt,
  };
}

// ---- parseAck -------------------------------------------------------------
// Backend contract (registry.ts buildControlAck):
// {schemaVersion, sessionId, runtimeId, generation, requestId, action?, jobId?,
//   accepted:boolean, reason, respondedAt}. No ackId, no nested identity, no at.
// action/jobId are absent on rejected parse-failure acks.

export function parseAck(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('ack: not an object');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`ack: bad schemaVersion ${raw.schemaVersion}`);
  }
  const sessionId = safeIdOrThrow(boundStr(raw.sessionId, 'sessionId', 128), 'sessionId');
  const runtimeId = safeIdOrThrow(boundStr(raw.runtimeId, 'runtimeId', 128), 'runtimeId');
  const generation = generationOf(raw.generation);
  const requestId = safeIdOrThrow(boundStr(raw.requestId, 'requestId', 128), 'requestId');
  let action;
  if (raw.action != null) {
    action = boundStr(raw.action, 'action', 64);
    if (action !== 'stop_one' && action !== 'stop_all') {
      throw new Error(`ack: unsupported action ${action}`);
    }
  }
  const jobId = raw.jobId != null
    ? safeIdOrThrow(boundStr(raw.jobId, 'jobId', 128), 'jobId')
    : undefined;
  if (typeof raw.accepted !== 'boolean') {
    throw new Error('ack: accepted must be a boolean');
  }
  const reason = boundStr(String(raw.reason ?? ''), 'reason', 1000);
  const respondedAt = finiteTs(raw.respondedAt, 'respondedAt');
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId,
    generation,
    requestId,
    action,
    jobId,
    accepted: raw.accepted,
    reason,
    respondedAt,
  };
}

// ---- extractSafeSessionId -------------------------------------------------
// Defensive extraction of an unambiguous safe session id from unknown shape.
// Only defensible fields: id / sessionId / session.id / session.sessionId.
// Arbitrary `key` inference is removed.

export function extractSafeSessionId(selectedSession) {
  if (selectedSession == null) return null;
  if (typeof selectedSession === 'string') {
    return isSafeId(selectedSession) ? selectedSession : null;
  }
  if (typeof selectedSession !== 'object') return null;

  const candidates = [
    selectedSession.id,
    selectedSession.sessionId,
    selectedSession.session?.id,
    selectedSession.session?.sessionId,
  ].filter(c => isSafeId(c));

  if (candidates.length === 0) return null;
  const unique = [...new Set(candidates)];
  if (unique.length > 1) return null; // ambiguous
  return unique[0];
}

// ---- Projection -----------------------------------------------------------

// Shutdown is terminal even with a recent heartbeat. An active runtime with a
// missing/null heartbeat is never fresh — it is stale/invalid.
export function computeStatus(runtime, now) {
  if (!runtime) return 'idle';
  if (runtime.state === 'shutdown') return 'shutdown';
  if (runtime.heartbeatAt == null || (now - runtime.heartbeatAt) > HEARTBEAT_STALE_MS) {
    return 'stale';
  }
  return 'active';
}

export function isActiveJobStatus(status) {
  return typeof status === 'string' && ACTIVE_JOB_STATUSES.includes(status);
}

export function isTerminalJobStatus(status) {
  return typeof status === 'string' && TERMINAL_JOB_STATUSES.includes(status);
}

// A job counts toward the active/badge number while routing/queued/running.
// A stop request (`stopping: true`) only ever coexists with a non-terminal
// status in backend records, so it is covered by the active status set.
export function isJobActive(job) {
  if (!job) return false;
  return isActiveJobStatus(job.status);
}

// Correct timing for backend job records:
// - elapsed: since startedAt (fallback createdAt)
// - queueAge: since createdAt
// - progressAge: since lastProgressAt / lastOutputAt / startedAt / createdAt
// - timedOut: past the job's own timeoutAt, or past the default progress
//   timeout when the record carries no timeoutAt.
export function computeJobTiming(job, now, _timeoutMs = DEFAULT_JOB_TIMEOUT_MS) {
  const anchor = job.startedAt ?? job.createdAt ?? 0;
  // Terminal elapsed time is immutable. Without this clamp, completed jobs
  // appear to keep running forever after reconnect while the local UI ticks.
  const end = Number.isFinite(job.finishedAt) ? job.finishedAt : now;
  const elapsed = Math.max(0, end - anchor);
  const queueAge = job.createdAt != null ? Math.max(0, now - job.createdAt) : 0;
  const lastActivity = job.lastProgressAt ?? job.lastOutputAt ?? job.startedAt ?? job.createdAt;
  const progressAge = lastActivity != null ? Math.max(0, now - lastActivity) : elapsed;
  // Only the backend's explicit timeoutAt is authoritative. Silence while a
  // job is routing/queued is not a timeout and must not be presented as one.
  const timedOut = typeof job.timeoutAt === 'number' && Number.isFinite(job.timeoutAt)
    ? now > job.timeoutAt
    : false;
  return { elapsed, queueAge, progressAge, timedOut };
}

// Pick the newest runtime per source: generation first (a newer generation
// supersedes an older one), then startedAt, then updatedAt, then runtimeId for
// a deterministic tiebreak. Old-generation records are preserved in the
// snapshot as stale history but never selected.
export function newestRuntimePerSource(runtimes) {
  const bySource = new Map();
  for (const r of runtimes) {
    const src = r.source ?? '';
    const prev = bySource.get(src);
    if (!prev || runtimeIsNewer(r, prev)) bySource.set(src, r);
  }
  return bySource;
}

export function runtimeIsNewer(a, b) {
  if (a.generation !== b.generation) return a.generation > b.generation;
  if ((a.startedAt ?? 0) !== (b.startedAt ?? 0)) return (a.startedAt ?? 0) > (b.startedAt ?? 0);
  if ((a.updatedAt ?? 0) !== (b.updatedAt ?? 0)) return (a.updatedAt ?? 0) > (b.updatedAt ?? 0);
  return a.runtimeId < b.runtimeId; // deterministic tiebreak
}

// projectSession({ runtimes, agentsList, plans, now, jobTimeoutMs })
// - runtimes: array of parsed runtime public projections
// - agentsList: array of parsed agents objects
// - plans: array of parsed plan objects
// - now: number (ms)
// Returns: { primary, sources, plan, status, jobs, activeCount, badge }
// Jobs are bound ONLY to the selected smart-subagents runtime (sessionId +
// runtimeId + generation all match) — jobs from other generations/runtimes are
// never combined. The plan chip binds only to the selected plan-mode runtime
// and generation.

export function projectSession({ runtimes = [], agentsList = [], plans = [], now, jobTimeoutMs } = {}) {
  if (!Number.isFinite(now)) throw new Error('projectSession: now must be finite');

  const sources = newestRuntimePerSource(runtimes);
  const selected = [...sources.values()];
  selected.sort((a, b) => (runtimeIsNewer(a, b) ? -1 : 1));
  const primary = selected[0] ?? null;

  // Bind agents to the selected smart-subagents runtime only.
  const smart = sources.get(SOURCE_SMART) ?? null;
  const allJobs = [];
  if (smart) {
    for (const a of agentsList) {
      if (a.sessionId === smart.sessionId && a.runtimeId === smart.runtimeId && a.generation === smart.generation) {
        for (const j of a.jobs) allJobs.push(j);
      }
    }
  }

  // Bind the plan chip to the selected plan-mode runtime only.
  const planRuntime = sources.get(SOURCE_PLAN) ?? null;
  let plan = null;
  if (planRuntime) {
    for (const p of plans) {
      if (p.sessionId === planRuntime.sessionId && p.runtimeId === planRuntime.runtimeId && p.generation === planRuntime.generation) {
        if (!plan || (p.updatedAt ?? 0) > (plan.updatedAt ?? 0)) plan = p;
      }
    }
  }

  // Active first (routing/queued/running/stopping); within each group newest first.
  allJobs.sort((a, b) => {
    const aActive = isJobActive(a) ? 0 : 1;
    const bActive = isJobActive(b) ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    const aAt = a.startedAt ?? a.createdAt ?? 0;
    const bAt = b.startedAt ?? b.createdAt ?? 0;
    if (aAt !== bAt) return bAt - aAt;
    return (a.queuePosition ?? 0) - (b.queuePosition ?? 0);
  });

  const jobs = allJobs.map(j => ({
    ...j,
    timing: computeJobTiming(j, now, jobTimeoutMs),
  }));

  const status = computeStatus(primary, now);
  const activeCount = jobs.filter(j => isJobActive(j)).length;
  const badge = activeCount > 0 ? String(activeCount) : '';

  return { primary, sources, plan, status, jobs, activeCount, badge };
}

// ---- Control --------------------------------------------------------------

function genUuid() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  // Safe fallback (not cryptographic, but unique enough for envelope ids)
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// buildControlEnvelope({ capability, action, jobId, requestId, ttlMs, now, runtimeStatus })
// action: 'stop_one' | 'stop_all'
// Produces EXACTLY the top-level protocol expected by the backend
// parseControlRequest (registry.ts): {schemaVersion, sessionId, runtimeId,
//   generation, controlToken, requestId, action, jobId?, createdAt, expiresAt}.
// No nested identity/envelopeId/ttlMs extras. TTL is bounded to <= 10s
// (backend allows up to 60s). Refuses shutdown/stale/missing capability.

export function buildControlEnvelope({ capability, action, jobId, requestId, ttlMs = DEFAULT_CONTROL_TTL_MS, now, runtimeStatus }) {
  if (!capability) throw new Error('buildControlEnvelope: missing capability');
  if (runtimeStatus === 'shutdown') throw new Error('refuse: runtime shutdown');
  if (runtimeStatus === 'stale') throw new Error('refuse: runtime stale');
  if (action !== 'stop_one' && action !== 'stop_all') {
    throw new Error(`unknown action: ${action}`);
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be positive finite');
  if (ttlMs > CONTROL_MAX_TTL_MS) {
    throw new Error(`ttlMs ${ttlMs} exceeds max ${CONTROL_MAX_TTL_MS}`);
  }
  if (!Number.isFinite(now)) throw new Error('now must be finite');

  const reqId = requestId || genUuid();
  if (!isSafeId(reqId)) throw new Error('requestId must be a safe id');

  if (action === 'stop_one') {
    if (!jobId || !isSafeId(jobId)) {
      throw new Error('stop_one requires exact safe job id');
    }
  }

  const env = {
    schemaVersion: SCHEMA_VERSION,
    sessionId: capability.sessionId,
    runtimeId: capability.runtimeId,
    generation: capability.generation,
    controlToken: capability.controlToken,
    requestId: reqId,
    action,
    createdAt: now,
    expiresAt: now + ttlMs,
  };
  if (action === 'stop_one') env.jobId = jobId;
  return Object.freeze(env);
}

// matchAck(ack, envelope) -> boolean
// Exact match against the registry.ts top-level protocol: sessionId, runtimeId,
// generation, requestId must all be equal; action/jobId must match when the
// ack carries them (rejected parse-failure acks omit action/jobId).
export function matchAck(ack, envelope) {
  if (!ack || !envelope) return false;
  if (ack.sessionId !== envelope.sessionId) return false;
  if (ack.runtimeId !== envelope.runtimeId) return false;
  if (ack.generation !== envelope.generation) return false;
  if (ack.requestId !== envelope.requestId) return false;
  if (ack.action != null && ack.action !== envelope.action) return false;
  if (ack.jobId != null && ack.jobId !== envelope.jobId) return false;
  return true;
}
