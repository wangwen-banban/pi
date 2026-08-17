// activity-view-model.js — Pure render-only view model for the Activity UI.
// Consumes frozen store state + an unknown selectedSession + the caller's `now`
// and produces a safe, JSON-serializable render model for the panel/DOM layer.
//
// Secrecy contract: the returned object (and its JSON serialization) NEVER
// contains a controlToken, a PID, full task text, parent context, or live
// output. State is read defensively; `state.capabilities` / `state.pendingRequests`
// are consulted only to derive safe booleans + owner ids and are never copied
// into the output. The parser (activity-schema.js) already bounds every string
// and array; this module re-bounds as a second line of defense.

import {
  SOURCE_SMART,
  SOURCE_PLAN,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_CONTROL_TTL_MS,
  MAX_STR,
  MAX_ARR,
  computeStatus,
  projectSession,
  isJobActive,
  extractSafeSessionId,
} from './activity-schema.js';

const MAX_DIAGNOSTICS = 50;

function capKey(sessionId, runtimeId) {
  return `${sessionId}/${runtimeId}`;
}

function boundStr(v) {
  if (typeof v !== 'string') return null;
  return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
}

function boundStrArr(v) {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_ARR).map((s) => {
    if (typeof s === 'string') return boundStr(s);
    return boundStr(String(s));
  });
}

// ---- Pure formatting helpers (stable across local 1s ticks) ----------------

/** `formatDuration(ms)` -> "12s", "1m 05s", "1h 02m 03s". Negative/non-finite -> "0s". */
export function formatDuration(ms) {
  const total = Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : 0;
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (x) => String(x).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/** `formatRelative(ts, now)` -> "just now", "5s ago", "3m ago", "in 10s". */
export function formatRelative(ts, now) {
  if (!Number.isFinite(ts) || !Number.isFinite(now)) return '';
  const diff = now - ts;
  const abs = Math.abs(diff);
  if (abs < 1000) return 'just now';
  const future = diff < 0;
  let text;
  if (abs < 60_000) text = `${Math.floor(abs / 1000)}s`;
  else if (abs < 3_600_000) text = `${Math.floor(abs / 60_000)}m`;
  else text = `${Math.floor(abs / 3_600_000)}h`;
  return future ? `in ${text}` : `${text} ago`;
}

// ---- Job display status ----------------------------------------------------
// Precedence (active jobs only):
//   1. an explicit stop — backend `stopping` flag OR an in-flight pending
//      control request — displays `stopping`;
//   2. an active job whose owning SMART runtime has gone stale displays `stale`
//      (plan runtime liveness never affects job status);
//   3. otherwise the exact backend status (routing/queued/running/completed/
//      failed/stopped). Terminal jobs always keep their backend status.
export function computeJobDisplayStatus(job, smartStatus, pendingStop = false) {
  if (!job) return 'idle';
  if (isJobActive(job)) {
    if (job.stopping === true || pendingStop) return 'stopping';
    if (smartStatus === 'stale') return 'stale';
  }
  return job.status;
}

// ---- Internal projection helpers ------------------------------------------

// Pending control requests that target the CURRENT smart runtime owner of a
// session (sessionId + runtimeId must both match — an older generation's
// request never marks a newer owner's jobs). Only `pending` requests count;
// accepted/rejected/timeout requests are terminal and ignored here.
function pendingActionsFor(state, sessionId, smartRuntime) {
  const result = { stopAll: false, stopOneIds: new Set() };
  if (!smartRuntime || !state || !state.pendingRequests) return result;
  const requests = state.pendingRequests;
  for (const key of Object.keys(requests)) {
    const req = requests[key];
    if (!req || req.status !== 'pending') continue;
    if (req.sessionId !== sessionId || req.runtimeId !== smartRuntime.runtimeId) continue;
    const action = req.envelope && req.envelope.action;
    if (action === 'stop_all') result.stopAll = true;
    else if (action === 'stop_one' && req.envelope && req.envelope.jobId) {
      result.stopOneIds.add(req.envelope.jobId);
    }
  }
  return result;
}

function jobView(job, smartStatus, pending, freshActiveSmart) {
  const pendingStop = pending.stopAll || pending.stopOneIds.has(job.id);
  const displayStopping = isJobActive(job) && (job.stopping === true || pendingStop);
  return {
    id: job.id,
    name: boundStr(job.name),
    status: computeJobDisplayStatus(job, smartStatus, pendingStop),
    backendStatus: job.status,
    stopping: displayStopping,
    queuePosition: job.queuePosition ?? null,
    model: boundStr(job.model),
    modelName: boundStr(job.modelName),
    providerName: boundStr(job.providerName),
    thinking: boundStr(job.thinking),
    context: boundStr(job.context),
    permission: boundStr(job.permission),
    elapsed: job.timing ? job.timing.elapsed : 0,
    queueAge: job.timing ? job.timing.queueAge : 0,
    progressAge: job.timing ? job.timing.progressAge : 0,
    timedOut: job.timing ? job.timing.timedOut === true : false,
    timeoutAt: job.timeoutAt ?? null,
    progress: boundStrArr(job.progress),
    changedFiles: boundStrArr(job.changedFiles),
    resultSummary: boundStr(job.resultSummary),
    errorSummary: boundStr(job.errorSummary),
    logPath: boundStr(job.logPath),
    canStop: isJobActive(job) && freshActiveSmart,
  };
}

function planView(planRecord, planRuntime, now) {
  return {
    state: planRecord ? planRecord.state : 'inactive',
    reason: boundStr(planRecord ? planRecord.reason : '') ?? '',
    since: planRecord ? planRecord.since : null,
    runtimeStatus: computeStatus(planRuntime, now),
  };
}

// Stop ownership handed to the controller: only a boolean + owner ids.
// `available` means there is at least one active job AND a fresh, active smart
// runtime whose private control capability is present. Never the token.
function stopView(sessionId, smartRuntime, freshActiveSmart, activeCount, reason) {
  if (!smartRuntime) return null;
  return {
    available: freshActiveSmart && activeCount > 0,
    sessionId,
    runtimeId: smartRuntime.runtimeId,
    generation: smartRuntime.generation,
    reason: freshActiveSmart ? null : (boundStr(reason) ?? 'Stop unavailable: runtime owner is unavailable'),
  };
}

// ---- Main entry -----------------------------------------------------------

/**
 * buildViewModel(state, selectedSession, now, options)
 * - state: store state (snapshot + capabilities + pendingRequests + diagnostics)
 * - selectedSession: unknown shape (defensively extracted; never hides others)
 * - now: finite ms timestamp (used for liveness + local elapsed timing)
 * - options: { jobTimeoutMs, uiErrors }
 */
export function buildViewModel(state, selectedSession, now, options = {}) {
  if (!Number.isFinite(now)) throw new Error('buildViewModel: now must be finite');
  const jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const uiErrors = Array.isArray(options.uiErrors) ? options.uiErrors : [];

  const selectedId = extractSafeSessionId(selectedSession);
  const sessionsMap = (state && state.snapshot && state.snapshot.sessions) || {};
  const capabilities = (state && state.capabilities) || {};

  const sessions = [];
  let totalActive = 0;

  for (const sessionId of Object.keys(sessionsMap).sort()) {
    const data = sessionsMap[sessionId] || {};
    const proj = projectSession({
      runtimes: data.runtimes || [],
      agentsList: data.agentsList || [],
      plans: data.plans || [],
      now,
      jobTimeoutMs,
    });

    const smartRuntime = proj.sources.get(SOURCE_SMART) || null;
    const smartStatus = computeStatus(smartRuntime, now);
    const capabilityPresent = smartRuntime
      ? Boolean(capabilities[capKey(sessionId, smartRuntime.runtimeId)])
      : false;
    const heartbeatAge = smartRuntime && Number.isFinite(smartRuntime.heartbeatAt)
      ? now - smartRuntime.heartbeatAt
      : Number.POSITIVE_INFINITY;
    const controlHeartbeatFresh = heartbeatAge <= DEFAULT_CONTROL_TTL_MS;
    const freshActiveSmart = smartStatus === 'active' && capabilityPresent && controlHeartbeatFresh;
    const controlUnavailableReason = !capabilityPresent
      ? 'Stop unavailable: no control capability for this runtime'
      : !controlHeartbeatFresh
        ? 'Stop unavailable: runtime owner heartbeat is older than the control request TTL'
        : 'Stop unavailable: runtime owner is not active';

    const pending = pendingActionsFor(state, sessionId, smartRuntime);
    const jobs = proj.jobs.map((job) => jobView(job, smartStatus, pending, freshActiveSmart));

    const activeCount = proj.activeCount;
    totalActive += activeCount;

    const planRuntime = proj.sources.get(SOURCE_PLAN) || null;

    sessions.push({
      sessionId,
      selected: sessionId === selectedId,
      status: proj.status,
      smartStatus,
      active: activeCount > 0,
      activeCount,
      badge: proj.badge,
      hasRuntime: proj.primary != null,
      primarySource: proj.primary ? proj.primary.source : null,
      primaryGeneration: proj.primary ? proj.primary.generation : null,
      plan: planView(proj.plan, planRuntime, now),
      jobs,
      stop: stopView(sessionId, smartRuntime, freshActiveSmart, activeCount, controlUnavailableReason),
      stopPending: pending.stopAll || pending.stopOneIds.size > 0,
    });
  }

  // Grouped sort: active sessions first, then selected, then id ascending.
  sessions.sort((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    if (a.selected !== b.selected) return a.selected ? -1 : 1;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  const diagnostics = Array.isArray(state && state.diagnostics)
    ? state.diagnostics.slice(-MAX_DIAGNOSTICS).map((d) => ({
        level: d && typeof d.level === 'string' ? d.level : 'info',
        message: boundStr(d && d.message) ?? '',
        at: d && Number.isFinite(d.at) ? d.at : now,
      }))
    : [];

  const errors = uiErrors.slice(-MAX_DIAGNOSTICS).map((e) => ({
    message: boundStr(e && e.message) ?? '',
    at: e && Number.isFinite(e.at) ? e.at : now,
  }));

  return {
    disconnected: (state && state.disconnected) === true,
    now,
    totalActive,
    badge: totalActive > 0 ? String(totalActive) : '',
    sessions,
    diagnostics,
    errors,
    lastSuccessAt: state && Number.isFinite(state.lastSuccessAt) ? state.lastSuccessAt : null,
  };
}
