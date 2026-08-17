// activity-store.js — WorkspaceFiles data/client layer for PI WEB Activity browser plugin
// Pure-ish async operations using only public WorkspaceFiles methods (v2).
// No DOM, REST, terminal, backend, or external deps.

import {
  BASE, SCHEMA_VERSION, DEFAULT_CONTROL_TTL_MS,
  sessionsDir, sessionDir, runtimesDir, runtimeDir,
  requestsDir, requestTempPath, requestFinalPath, acksDir, ackPath,
  isSafeId, parseRuntime, parseAgents, parsePlan, parseBackgroundTasks, parseAck,
  buildControlEnvelope, matchAck, computeStatus,
} from './activity-schema.js';

// ---- Error codes ----------------------------------------------------------

export const ERR_ROOT_ABSENT = 'ROOT_ABSENT';
export const ERR_DISCONNECTED = 'DISCONNECTED';

// ---- Helpers --------------------------------------------------------------

function isEnoent(err) {
  if (!err) return false;
  if (err.code === 'ENOENT') return true;
  if (err.cause?.code === 'ENOENT') return true;
  const msg = String(err.message || err).toLowerCase();
  return msg.includes('no such file') || msg.includes('not exist') || msg.includes('does not exist');
}

function capKey(sessionId, runtimeId) {
  return `${sessionId}/${runtimeId}`;
}

function reqKey(sessionId, runtimeId, requestId) {
  return `${sessionId}/${runtimeId}/${requestId}`;
}

function addDiagnostic(state, level, message, now) {
  const entry = { level, message, at: now };
  const diagnostics = [...(state.diagnostics || []), entry];
  // Cap at 50 entries, keep most recent
  return diagnostics.length > 50 ? diagnostics.slice(-50) : diagnostics;
}

function parseJsonSafe(content, path) {
  try {
    return { ok: true, value: JSON.parse(content) };
  } catch (err) {
    return { ok: false, error: `JSON parse error at ${path}: ${err.message}` };
  }
}

async function safeList(files, path) {
  let result;
  try {
    result = await files.listFiles(path);
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: true, enoent: true, entries: [] };
    }
    return { ok: false, error: err };
  }
  // A truncated listing is not a valid complete registry enumeration.
  if (result && result.truncated === true) {
    return { ok: false, invalid: 'truncated' };
  }
  return { ok: true, entries: (result && result.entries) || [] };
}

async function safeRead(files, path) {
  let result;
  try {
    result = await files.readFile(path);
  } catch (err) {
    if (isEnoent(err)) {
      return { ok: true, enoent: true, content: null };
    }
    return { ok: false, error: err };
  }
  // Truncated, binary, or non-utf8 reads are not valid complete registry reads.
  if (!result || typeof result.content !== 'string') {
    return { ok: false, invalid: 'non-utf8' };
  }
  if (result.binary === true) {
    return { ok: false, invalid: 'binary' };
  }
  if (result.truncated === true) {
    return { ok: false, invalid: 'truncated' };
  }
  if (result.encoding != null && result.encoding !== 'utf8') {
    return { ok: false, invalid: 'non-utf8' };
  }
  return { ok: true, content: result.content };
}

// Bounded diagnostic detail (cap message length).
function boundText(value, max = 200) {
  const s = String(value == null ? '' : value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// Extract a human-readable failure detail from a safeList/safeRead result.
function failureDetail(result) {
  if (result && result.error) {
    const err = result.error;
    return err && err.message ? err.message : String(err);
  }
  if (result && result.invalid) return `invalid read: ${result.invalid}`;
  return 'unknown failure';
}

// Disconnected poll result: keep the previous last-good snapshot/capabilities,
// mark disconnected, and append a bounded error diagnostic naming the layer.
function disconnectedResult(state, layer, detail, now) {
  return {
    ...state,
    disconnected: true,
    diagnostics: addDiagnostic(state, 'error', `Disconnected polling ${layer}: ${boundText(detail)}`, now),
  };
}

// ---- Cache key helper -----------------------------------------------------

export function cacheKey(machine, workspace) {
  const m = (machine && typeof machine === 'object' && machine.id) ? machine.id : '';
  const w = (workspace && typeof workspace === 'object' && workspace.id) ? workspace.id : '';
  return `${m}::${w}`;
}

// ---- Initial state --------------------------------------------------------

export function createInitialState({ cacheKey: ck = '' } = {}) {
  return {
    cacheKey: ck,
    disconnected: false,
    snapshot: null,
    capabilities: {},
    pendingRequests: {},
    diagnostics: [],
    lastSuccessAt: null,
  };
}

// ---- refreshActivity ------------------------------------------------------

export async function refreshActivity(files, previousState, now, options = {}) {
  const state = previousState || createInitialState();
  let diagnostics = [...(state.diagnostics || [])];

  // Check if cacheKey changed (different machine/workspace)
  const newCacheKey = options.cacheKey || state.cacheKey;
  if (newCacheKey && newCacheKey !== state.cacheKey) {
    // CacheKey changed — clear cache and start fresh
    return {
      ...createInitialState({ cacheKey: newCacheKey }),
      lastSuccessAt: null,
    };
  }

  // 1. List sessions dir
  const sessionsListResult = await safeList(files, sessionsDir());
  if (!sessionsListResult.ok) {
    // Hard failure — keep last good snapshot/capabilities, mark disconnected.
    return disconnectedResult(state, 'sessions', failureDetail(sessionsListResult), now);
  }

  if (sessionsListResult.enoent) {
    // Valid empty — no sessions dir yet
    return {
      ...state,
      disconnected: false,
      snapshot: { sessions: {} },
      capabilities: {},
      diagnostics: [],
      lastSuccessAt: now,
    };
  }

  // 2. Enumerate sessions
  const sessionEntries = sessionsListResult.entries
    .filter(e => e.type === 'directory' && isSafeId(e.name))
    .map(e => e.name)
    .sort();

  const sessions = {};
  const capabilities = {};

  for (const sessionId of sessionEntries) {
    const runtimesListResult = await safeList(files, runtimesDir(sessionId));
    if (!runtimesListResult.ok) {
      return disconnectedResult(state, `runtimes (${sessionId})`, failureDetail(runtimesListResult), now);
    }
    if (runtimesListResult.enoent) continue;

    const runtimeEntries = runtimesListResult.entries
      .filter(e => e.type === 'directory' && isSafeId(e.name))
      .map(e => e.name)
      .sort();

    const runtimes = [];
    const agentsList = [];
    const plans = [];
    const backgroundsList = [];

    for (const runtimeId of runtimeEntries) {
      // Read runtime.json (required)
      const rtPath = `${runtimeDir(sessionId, runtimeId)}/runtime.json`;
      const rtReadResult = await safeRead(files, rtPath);
      if (!rtReadResult.ok) {
        return disconnectedResult(state, `runtime.json (${sessionId}/${runtimeId})`, failureDetail(rtReadResult), now);
      }
      if (rtReadResult.enoent) continue; // disappeared mid-poll

      const rtJsonResult = parseJsonSafe(rtReadResult.content, rtPath);
      if (!rtJsonResult.ok) {
        diagnostics = addDiagnostic({ diagnostics }, 'warn', rtJsonResult.error, now);
        continue;
      }

      let parsed;
      try {
        parsed = parseRuntime(rtJsonResult.value);
      } catch (err) {
        diagnostics = addDiagnostic({ diagnostics }, 'warn', `Invalid runtime at ${rtPath}: ${err.message}`, now);
        continue;
      }

      // Validate identity matches path
      if (parsed.public.sessionId !== sessionId || parsed.public.runtimeId !== runtimeId) {
        diagnostics = addDiagnostic({ diagnostics }, 'warn', `Identity mismatch at ${rtPath}`, now);
        continue;
      }

      runtimes.push(parsed.public);
      if (parsed.capability) {
        capabilities[capKey(sessionId, runtimeId)] = parsed.capability;
      }

      // Read optional agents.json — must belong to this path session/runtime.
      const agentsPath = `${runtimeDir(sessionId, runtimeId)}/agents.json`;
      const agentsReadResult = await safeRead(files, agentsPath);
      if (!agentsReadResult.ok) {
        return disconnectedResult(state, `agents.json (${sessionId}/${runtimeId})`, failureDetail(agentsReadResult), now);
      }
      if (!agentsReadResult.enoent) {
        const agentsJsonResult = parseJsonSafe(agentsReadResult.content, agentsPath);
        if (agentsJsonResult.ok) {
          try {
            const parsedAgents = parseAgents(agentsJsonResult.value);
            if (parsedAgents.sessionId !== sessionId || parsedAgents.runtimeId !== runtimeId) {
              diagnostics = addDiagnostic({ diagnostics }, 'warn', `Identity mismatch at ${agentsPath}`, now);
            } else {
              agentsList.push(parsedAgents);
            }
          } catch (err) {
            diagnostics = addDiagnostic({ diagnostics }, 'warn', `Invalid agents at ${agentsPath}: ${err.message}`, now);
          }
        } else {
          diagnostics = addDiagnostic({ diagnostics }, 'warn', agentsJsonResult.error, now);
        }
      }

      // Read optional background-tasks.json — exact identity binding prevents
      // stale task plans from an older runtime generation being merged.
      const backgroundPath = `${runtimeDir(sessionId, runtimeId)}/background-tasks.json`;
      const backgroundReadResult = await safeRead(files, backgroundPath);
      if (!backgroundReadResult.ok) {
        return disconnectedResult(state, `background-tasks.json (${sessionId}/${runtimeId})`, failureDetail(backgroundReadResult), now);
      }
      if (!backgroundReadResult.enoent) {
        const backgroundJsonResult = parseJsonSafe(backgroundReadResult.content, backgroundPath);
        if (backgroundJsonResult.ok) {
          try {
            const parsedBackground = parseBackgroundTasks(backgroundJsonResult.value);
            if (parsedBackground.sessionId !== sessionId || parsedBackground.runtimeId !== runtimeId) {
              diagnostics = addDiagnostic({ diagnostics }, 'warn', `Identity mismatch at ${backgroundPath}`, now);
            } else {
              backgroundsList.push(parsedBackground);
            }
          } catch (err) {
            diagnostics = addDiagnostic({ diagnostics }, 'warn', `Invalid background tasks at ${backgroundPath}: ${err.message}`, now);
          }
        } else {
          diagnostics = addDiagnostic({ diagnostics }, 'warn', backgroundJsonResult.error, now);
        }
      }

      // Read optional plan-mode.json — must belong to this path session/runtime.
      const planPath = `${runtimeDir(sessionId, runtimeId)}/plan-mode.json`;
      const planReadResult = await safeRead(files, planPath);
      if (!planReadResult.ok) {
        return disconnectedResult(state, `plan-mode.json (${sessionId}/${runtimeId})`, failureDetail(planReadResult), now);
      }
      if (!planReadResult.enoent) {
        const planJsonResult = parseJsonSafe(planReadResult.content, planPath);
        if (planJsonResult.ok) {
          try {
            const parsedPlan = parsePlan(planJsonResult.value);
            if (parsedPlan.sessionId !== sessionId || parsedPlan.runtimeId !== runtimeId) {
              diagnostics = addDiagnostic({ diagnostics }, 'warn', `Identity mismatch at ${planPath}`, now);
            } else {
              plans.push(parsedPlan);
            }
          } catch (err) {
            diagnostics = addDiagnostic({ diagnostics }, 'warn', `Invalid plan at ${planPath}: ${err.message}`, now);
          }
        } else {
          diagnostics = addDiagnostic({ diagnostics }, 'warn', planJsonResult.error, now);
        }
      }
    }

    if (runtimes.length > 0 || agentsList.length > 0 || plans.length > 0 || backgroundsList.length > 0) {
      sessions[sessionId] = { runtimes, agentsList, plans, backgroundsList };
    }
  }

  // 3. Build new snapshot
  const snapshot = { sessions };

  // 4. Return updated state
  return {
    ...state,
    disconnected: false,
    snapshot,
    capabilities,
    diagnostics: diagnostics.length > 50 ? diagnostics.slice(-50) : diagnostics,
    lastSuccessAt: now,
  };
}

// ---- publishControl -------------------------------------------------------

export async function publishControl(files, state, params) {
  const { sessionId, runtimeId, action, jobId, requestId: explicitRequestId, ttlMs, now } = params;

  // 1. Get capability
  const capability = state.capabilities[capKey(sessionId, runtimeId)];
  if (!capability) {
    throw new Error(`No capability for ${capKey(sessionId, runtimeId)}`);
  }

  // 2. Get runtime status
  const sessionData = state.snapshot?.sessions?.[sessionId];
  if (!sessionData) {
    throw new Error(`Session ${sessionId} not found in snapshot`);
  }
  const runtime = sessionData.runtimes.find(r => r.runtimeId === runtimeId);
  if (!runtime) {
    throw new Error(`Runtime ${runtimeId} not found in session ${sessionId}`);
  }

  // Compute runtime status: shutdown is terminal even with a fresh heartbeat;
  // an active runtime with a missing/stale heartbeat is never fresh.
  const runtimeStatus = computeStatus(runtime, now);

  // 3. Build envelope (validates/refuses)
  const envelope = buildControlEnvelope({
    capability,
    action,
    jobId,
    requestId: explicitRequestId,
    ttlMs,
    now,
    runtimeStatus,
  });
  const controlTtlMs = envelope.expiresAt - envelope.createdAt;
  const heartbeatAge = now - runtime.heartbeatAt;
  if (!Number.isFinite(heartbeatAge) || heartbeatAge > (controlTtlMs || DEFAULT_CONTROL_TTL_MS)) {
    throw new Error('Stop unavailable: runtime owner heartbeat is older than the control request TTL');
  }

  const requestId = envelope.requestId;
  const tempPath = requestTempPath(sessionId, runtimeId, requestId);
  const finalPath = requestFinalPath(sessionId, runtimeId, requestId);

  // 4. Write temp file
  try {
    await files.writeFile(tempPath, JSON.stringify(envelope), { overwrite: false, createDirs: true });
  } catch (err) {
    throw new Error(`Failed to write temp request: ${err.message}`);
  }

  // 5. Move temp → final
  try {
    await files.moveFile(tempPath, finalPath, { overwrite: false, createDirs: true });
  } catch (err) {
    // Cleanup temp best effort
    try {
      await files.deleteFile(tempPath);
    } catch (_) { /* ignore */ }
    throw new Error(`Failed to move request to final: ${err.message}`);
  }

  // 6. Track in pendingRequests
  const key = reqKey(sessionId, runtimeId, requestId);
  const pendingRequests = {
    ...state.pendingRequests,
    [key]: {
      sessionId,
      runtimeId,
      requestId,
      envelope,
      tempPath,
      finalPath,
      status: 'pending',
      publishedAt: now,
      expiresAt: envelope.expiresAt,
    },
  };

  return {
    ...state,
    pendingRequests,
  };
}

// ---- checkAck -------------------------------------------------------------

export async function checkAck(files, state, requestKey, now) {
  const pending = state.pendingRequests[requestKey];
  if (!pending) {
    throw new Error(`No pending request for key ${requestKey}`);
  }

  const { sessionId, runtimeId, requestId, envelope, finalPath } = pending;

  // 1. List acks dir
  const acksListResult = await safeList(files, acksDir(sessionId, runtimeId));
  if (!acksListResult.ok) {
    throw new Error(`Failed to list acks: ${failureDetail(acksListResult)}`);
  }

  if (acksListResult.enoent) {
    // No acks dir — check timeout
    if (now >= pending.expiresAt) {
      // Best-effort delete the exact final request file before marking timeout.
      try {
        await files.deleteFile(finalPath);
      } catch (_) { /* ignore */ }
      const pendingRequests = {
        ...state.pendingRequests,
        [requestKey]: { ...pending, status: 'timeout' },
      };
      return { ...state, pendingRequests };
    }
    return state; // still pending
  }

  // 2. Find ack with matching requestId
  const ackEntries = acksListResult.entries
    .filter(e => e.type === 'file' && e.name.endsWith('.json'))
    .map(e => e.name)
    .sort();

  for (const ackName of ackEntries) {
    const ackPath = `${acksDir(sessionId, runtimeId)}/${ackName}`;
    const ackReadResult = await safeRead(files, ackPath);
    if (!ackReadResult.ok || ackReadResult.enoent) continue;

    const ackJsonResult = parseJsonSafe(ackReadResult.content, ackPath);
    if (!ackJsonResult.ok) continue;

    let ack;
    try {
      ack = parseAck(ackJsonResult.value);
    } catch (_) {
      continue;
    }

    // Check if this ack is for our request
    if (ack.requestId !== requestId) continue;

    // 3. Check full match (identity + generation + action/jobId when present)
    if (matchAck(ack, envelope)) {
      // Matched — accepted when the backend accepted, rejected otherwise.
      const pendingRequests = {
        ...state.pendingRequests,
        [requestKey]: { ...pending, status: ack.accepted ? 'accepted' : 'rejected' },
      };

      // Best effort delete request file
      try {
        await files.deleteFile(finalPath);
      } catch (_) { /* ignore */ }

      // Best effort delete ack file
      try {
        await files.deleteFile(ackPath);
      } catch (_) { /* ignore */ }

      return { ...state, pendingRequests };
    } else {
      // Rejected — ack has same requestId but mismatched identity/generation/
      // action. Best effort delete request + ack (cleanup confinement: only our files)
      const pendingRequests = {
        ...state.pendingRequests,
        [requestKey]: { ...pending, status: 'rejected' },
      };

      try {
        await files.deleteFile(finalPath);
      } catch (_) { /* ignore */ }

      try {
        await files.deleteFile(ackPath);
      } catch (_) { /* ignore */ }

      return { ...state, pendingRequests };
    }
  }

  // No matching ack found — check timeout
  if (now >= pending.expiresAt) {
    // Best-effort delete the exact final request file before marking timeout.
    try {
      await files.deleteFile(finalPath);
    } catch (_) { /* ignore */ }
    const pendingRequests = {
      ...state.pendingRequests,
      [requestKey]: { ...pending, status: 'timeout' },
    };
    return { ...state, pendingRequests };
  }

  return state; // still pending
}

// ---- Utilities ------------------------------------------------------------

export function getCapability(state, sessionId, runtimeId) {
  return state.capabilities[capKey(sessionId, runtimeId)] || null;
}

export function getPendingRequest(state, requestKey) {
  return state.pendingRequests[requestKey] || null;
}

export function listPendingRequests(state) {
  return Object.values(state.pendingRequests);
}
