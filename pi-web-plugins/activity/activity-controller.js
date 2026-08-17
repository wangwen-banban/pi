// activity-controller.js — Non-DOM Activity UI controller.
// Owns the store state lifecycle (createInitialState + cache key), a 1s
// non-overlapping refresh tick, visibility/resume scheduling, and stop control
// (stop_one / stop_all) with pending-ack tracking. Depends only on injected
// WorkspaceFiles, machine/workspace, host.requestRender, a clock and a
// scheduler — no DOM, network, config or backend access.
//
// Secrecy contract: getView() returns the render-only view model (never raw
// capabilities/state); stop requests bind to the selected smart runtime owner
// via exact ids and the private capability map is accessed internally only.
// PID is never read or used.

import {
  cacheKey, createInitialState, refreshActivity, publishControl, checkAck,
  getPendingRequest, listPendingRequests,
} from './activity-store.js';
import { buildViewModel } from './activity-view-model.js';
import { isActiveJobStatus } from './activity-schema.js';

const DEFAULT_TICK_MS = 1000;
const MAX_ERRORS = 20;

export const MAX_TERMINAL_PENDING_REQUESTS = 100;

function defaultClock() {
  return Date.now();
}

function defaultScheduler() {
  return {
    setInterval(fn, ms) { return globalThis.setInterval(fn, ms); },
    clearInterval(handle) { globalThis.clearInterval(handle); },
  };
}

function requestKeyOf(req) {
  return `${req.sessionId}/${req.runtimeId}/${req.requestId}`;
}

// Terminal control requests (accepted/rejected/timeout) are retained only as
// bounded history: at most MAX_TERMINAL_PENDING_REQUESTS entries, keeping the
// most recent by publishedAt. Pending requests are never dropped — they are
// still being polled for acks. Returns a new state (input never mutated).
export function capTerminalPendingRequests(state, max = MAX_TERMINAL_PENDING_REQUESTS) {
  if (!state || typeof state !== 'object' || !state.pendingRequests || typeof state.pendingRequests !== 'object') {
    return state;
  }
  const entries = Object.entries(state.pendingRequests);
  const terminal = entries.filter(([, req]) => req && req.status !== 'pending');
  if (terminal.length <= max) return state;
  const keep = new Set();
  const byAge = [...terminal].sort((a, b) => (a[1].publishedAt ?? 0) - (b[1].publishedAt ?? 0));
  for (const [key] of byAge.slice(byAge.length - max)) keep.add(key);
  const next = {};
  for (const [key, req] of entries) {
    if (req && req.status !== 'pending' && !keep.has(key)) continue;
    next[key] = req;
  }
  return { ...state, pendingRequests: next };
}

/**
 * createActivityController(deps)
 * deps: {
 *   files: WorkspaceFiles (required),
 *   machine: { id }, workspace: { id } (for the cache key),
 *   host: { requestRender() } (required),
 *   clock: () => ms (default Date.now),
 *   scheduler: { setInterval(fn, ms), clearInterval(handle) },
 *   tickMs: number (default 1000),
 * }
 */
export function createActivityController(deps = {}) {
  const {
    files,
    machine,
    workspace,
    host,
    clock = defaultClock,
    scheduler = defaultScheduler(),
    tickMs = DEFAULT_TICK_MS,
  } = deps;

  if (!files) throw new Error('createActivityController: files is required');
  if (!host) throw new Error('createActivityController: host is required');

  let state = createInitialState({ cacheKey: cacheKey(machine, workspace) });
  let started = false;
  let visible = false;
  let timer = null;
  let inFlight = null;
  let refreshQueued = false;
  let selectedForView = null;
  const listeners = new Set();
  const errors = [];

  function pushError(message, at) {
    errors.push({ message: String(message), at });
    if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS);
  }

  function emitFreshView() {
    const view = buildViewModel(state, selectedForView, clock(), { uiErrors: errors });
    try { host.requestRender(); } catch (_) { /* host render is best-effort */ }
    for (const fn of listeners) {
      try { fn(view); } catch (_) { /* listener errors never break the tick */ }
    }
  }

  function ensureTimer() {
    if (timer !== null) return;
    if (!started || !visible) return;
    timer = scheduler.setInterval(() => { void tick(); }, tickMs);
  }

  function clearTimer() {
    if (timer !== null) {
      try { scheduler.clearInterval(timer); } catch (_) { /* best-effort */ }
      timer = null;
    }
  }

  // Advance pending control requests toward terminal (accepted/rejected/timeout).
  // Terminal requests are never polled again. Errors are bounded UI errors and
  // never destroy the last good snapshot.
  async function drainPending(prev, now) {
    let next = prev;
    for (const req of listPendingRequests(next)) {
      if (!req || req.status !== 'pending') continue;
      const key = requestKeyOf(req);
      try {
        const after = await checkAck(files, next, key, now);
        const updated = getPendingRequest(after, key);
        if (updated && updated.status !== 'pending') recordOutcome(updated, now);
        next = after;
      } catch (err) {
        pushError(`Ack check failed for ${req.requestId}: ${err.message}`, now);
      }
    }
    return next;
  }

  function recordOutcome(req, now) {
    if (req.status === 'rejected') pushError(`Stop request ${req.requestId} was rejected by the runtime`, now);
    else if (req.status === 'timeout') pushError(`Stop request ${req.requestId} timed out`, now);
    // accepted: no error — the backend reflects the stop on a later poll.
  }

  async function doRefresh() {
    const now = clock();
    let next;
    try {
      next = await refreshActivity(files, state, now);
    } catch (err) {
      pushError(`Refresh failed: ${err.message}`, now);
      next = state; // keep the last snapshot
    }
    next = await drainPending(next, clock());
    next = capTerminalPendingRequests(next);
    state = next;
    emitFreshView();
  }

  // Single-flight, coalescing tick: at most one refresh runs at a time; a
  // refresh requested while one is in flight queues exactly one more.
  function tick() {
    if (inFlight) {
      refreshQueued = true;
      return inFlight;
    }
    inFlight = (async () => {
      try {
        await doRefresh();
      } finally {
        inFlight = null;
        if (refreshQueued) {
          refreshQueued = false;
          if (started && visible) void tick();
        }
      }
    })();
    return inFlight;
  }

  function start() {
    if (started) return Promise.resolve();
    started = true;
    visible = true;
    ensureTimer();
    return tick();
  }

  function setVisible(v) {
    const next = v === true;
    const wasVisible = visible;
    visible = next;
    if (!started) return Promise.resolve();
    if (next) {
      ensureTimer();
      return wasVisible ? Promise.resolve() : tick(); // immediate refresh on false->true
    }
    clearTimer();
    return Promise.resolve();
  }

  function stop() {
    started = false;
    visible = false;
    refreshQueued = false;
    clearTimer();
  }

  function refreshNow() {
    if (!started) return Promise.resolve();
    return tick();
  }

  function getView(selectedSession) {
    selectedForView = selectedSession ?? null;
    return buildViewModel(state, selectedForView, clock(), { uiErrors: errors });
  }

  function stopUnavailableReason(session, job) {
    if (job) {
      if (!isActiveJobStatus(job.backendStatus)) return `Job ${job.id} is not active`;
    }
    if (!session.stop) return 'Stop unavailable: no smart runtime owner for this session';
    if ((session.smartActiveCount ?? session.activeCount) === 0) return 'Stop unavailable: no active sub-agent jobs';
    if (session.smartStatus === 'stale') return 'Stop unavailable: smart runtime is stale';
    if (session.smartStatus === 'shutdown') return 'Stop unavailable: smart runtime has shut down';
    if (session.smartStatus === 'idle') return 'Stop unavailable: smart runtime is missing';
    return session.stop.reason || 'Stop unavailable: no control capability for this runtime';
  }

  function hasPendingDuplicate(owner, action, jobId) {
    const requests = listPendingRequests(state);
    // A pending stop_all already covers every job of this runtime owner — any
    // further stop control (stop_all or stop_one) is redundant.
    const hasPendingStopAll = requests.some((req) =>
      req &&
      req.status === 'pending' &&
      req.sessionId === owner.sessionId &&
      req.runtimeId === owner.runtimeId &&
      req.envelope &&
      req.envelope.action === 'stop_all'
    );
    if (hasPendingStopAll) return true;
    if (action === 'stop_one') {
      return requests.some((req) =>
        req &&
        req.status === 'pending' &&
        req.sessionId === owner.sessionId &&
        req.runtimeId === owner.runtimeId &&
        req.envelope &&
        req.envelope.action === 'stop_one' &&
        req.envelope.jobId === jobId
      );
    }
    // stop_all escalation while only stop_one requests are pending is allowed.
    return false;
  }

  async function requestStop(sessionId, action, jobId) {
    const now = clock();
    const view = buildViewModel(state, selectedForView, now, { uiErrors: errors });
    const session = view.sessions.find((s) => s.sessionId === sessionId);
    if (!session) return { ok: false, reason: `Session ${sessionId} not found` };

    let job = null;
    if (action === 'stop_one') {
      job = session.jobs.find((j) => j.id === jobId);
      if (!job) return { ok: false, reason: `Job ${jobId} not found` };
      if (!job.canStop) return { ok: false, reason: stopUnavailableReason(session, job) };
    } else if (!(session.stop && session.stop.available)) {
      return { ok: false, reason: stopUnavailableReason(session, null) };
    }

    const owner = session.stop;
    if (hasPendingDuplicate(owner, action, jobId)) {
      return { ok: false, reason: 'Stop already pending' };
    }

    const params = {
      sessionId: owner.sessionId,
      runtimeId: owner.runtimeId,
      action,
      now,
    };
    if (action === 'stop_one') params.jobId = jobId;

    try {
      state = await publishControl(files, state, params);
    } catch (err) {
      pushError(`Stop failed: ${err.message}`, now);
      emitFreshView();
      return { ok: false, reason: err.message };
    }
    emitFreshView(); // pending state is visible immediately (job shows stopping)
    return { ok: true };
  }

  return {
    start,
    stop,
    setVisible,
    refreshNow,
    getView,
    stopOne: (sessionId, jobId) => requestStop(sessionId, 'stop_one', jobId),
    stopAll: (sessionId) => requestStop(sessionId, 'stop_all', null),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
