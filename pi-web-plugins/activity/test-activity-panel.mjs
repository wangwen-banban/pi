// test-activity-panel.mjs — node --test suite for activity-panel.js
// No external DOM libraries: pure rendered HTML/CSS, escaping, presentation
// helpers, controller cache behavior, badge/label callbacks against fake
// WorkspaceFiles, and static source-wiring checks. The custom element is only
// exercised through the exported pure helpers plus the guarded
// defineActivityPanelElement() (returns false outside a DOM).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SCHEMA_VERSION, sessionsDir, runtimesDir, runtimeDir,
  parseRuntime, parseAgents, parsePlan, parseBackgroundTasks,
} from './activity-schema.js';
import { buildViewModel, formatDuration } from './activity-view-model.js';
import {
  activityPanelTagName,
  defineActivityPanelElement,
  activityPanelBadge,
  activityWorkspaceLabelItems,
  renderActivityPanelHtml,
  activityStyles,
  escapeHtml,
  escapeAttr,
  truncateText,
  jobStatusPresentation,
  smartStatusPresentation,
  backgroundStatusPresentation,
  planChipPresentation,
  stopUnavailableReasonForSession,
  stopUnavailableReasonForJob,
  confirmStopAllMessage,
  controllerCacheKeyForContext,
  getControllerForContext,
  setActivityControllerFactory,
  resetActivityControllerCache,
  controllerCacheSize,
  CONTROLLER_CACHE_MAX,
  MAX_RENDERED_ERRORS,
  MAX_RENDERED_DIAGNOSTICS,
} from './activity-panel.js';

const NOW = 5_000_000;

// ---- fake WorkspaceFiles (mirrors test-activity-controller.mjs) -----------

function enoent(path) {
  const err = new Error(`ENOENT: no such file or directory '${path}'`);
  err.code = 'ENOENT';
  return err;
}

function createFakeFiles(files = {}) {
  return {
    async listFiles(path) {
      const content = files[path];
      if (content === undefined) throw enoent(path);
      if (content && Array.isArray(content.entries)) {
        return { path, entries: content.entries, truncated: false };
      }
      throw new Error(`listFiles: ${path} is not a directory`);
    },
    async readFile(path) {
      const content = files[path];
      if (content === undefined) throw enoent(path);
      if (typeof content === 'string') {
        return { path, content, encoding: 'utf8', size: content.length, truncated: false, binary: false };
      }
      throw new Error(`readFile: ${path} is not a file`);
    },
    async writeFile(path, content, options = {}) {
      if (files[path] !== undefined && !options.overwrite) throw new Error(`File exists: ${path}`);
      files[path] = content;
      return { path, size: content.length, created: true };
    },
    async moveFile(fromPath, toPath, options = {}) {
      if (files[fromPath] === undefined) throw enoent(fromPath);
      if (files[toPath] !== undefined && !options.overwrite) throw new Error(`File exists: ${toPath}`);
      files[toPath] = files[fromPath];
      delete files[fromPath];
      return { fromPath, toPath };
    },
    async deleteFile(path) {
      const existed = files[path] !== undefined;
      delete files[path];
      return { path, existed };
    },
  };
}

function listDir(...names) {
  return { entries: names.map((name) => ({ name, path: name, type: 'directory' })) };
}

function smartSessionFiles({ withPlan = false } = {}) {
  const sessionId = 'sess1';
  const runtimeId = 'rt-sess1';
  const now = Date.now();
  const files = {
    [sessionsDir()]: listDir(sessionId),
    [runtimesDir(sessionId)]: listDir(...(withPlan ? [runtimeId, 'rt-plan'] : [runtimeId])),
    [`${runtimeDir(sessionId, runtimeId)}/runtime.json`]: JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      source: 'smart-subagents',
      sessionId,
      runtimeId,
      generation: 0,
      controlToken: 'token-rt-sess1',
      state: 'active',
      startedAt: now - 60_000,
      updatedAt: now - 1_000,
      heartbeatAt: now - 1_000,
      jobs: { total: 1, active: 1 },
    }),
    [`${runtimeDir(sessionId, runtimeId)}/agents.json`]: JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      runtimeId,
      generation: 0,
      updatedAt: now - 1_000,
      jobs: [{
        id: 'j1',
        name: 'Job 1',
        status: 'running',
        stopping: false,
        createdAt: now - 90_000,
        startedAt: now - 60_000,
        progress: [],
        changedFiles: [],
      }],
    }),
  };
  if (withPlan) {
    files[`${runtimeDir(sessionId, 'rt-plan')}/runtime.json`] = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      source: 'plan-mode',
      sessionId,
      runtimeId: 'rt-plan',
      generation: 0,
      state: 'active',
      startedAt: now - 60_000,
      updatedAt: now - 1_000,
      heartbeatAt: now - 1_000,
    });
    files[`${runtimeDir(sessionId, 'rt-plan')}/plan-mode.json`] = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      runtimeId: 'rt-plan',
      generation: 0,
      state: 'active',
      reason: 'proactive planning',
      since: now - 30_000,
      updatedAt: now - 1_000,
      heartbeatAt: now - 1_000,
    });
  }
  return { files, sessionId };
}

// ---- backend-shaped record helpers (mirror schema contract) ----------------

function mkRuntimeRaw(sessionId, runtimeId, overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    source: 'smart-subagents',
    sessionId,
    runtimeId,
    generation: 0,
    controlToken: `secret-token-${runtimeId}`,
    state: 'active',
    startedAt: NOW - 120_000,
    updatedAt: NOW - 1_000,
    heartbeatAt: NOW - 1_000,
    jobs: { total: 1, active: 1 },
    ...overrides,
  };
}

function mkJobRaw(overrides = {}) {
  return {
    id: 'j1',
    name: 'Deploy preview',
    status: 'running',
    stopping: false,
    queuePosition: undefined,
    createdAt: NOW - 90_000,
    startedAt: NOW - 60_000,
    lastProgressAt: NOW - 8_000,
    timeoutAt: NOW + 60_000,
    model: 'opencode/gpt-5',
    modelName: 'gpt-5',
    providerName: 'OpenAI',
    thinking: 'high',
    context: 'isolated',
    permission: 'workspace-write',
    progress: ['install deps', 'run build'],
    changedFiles: ['src/app.js'],
    resultSummary: 'preview deployed',
    logPath: '/tmp/j1.log',
    ...overrides,
  };
}

function viewState({
  sessionId = 'sess1',
  jobs = [mkJobRaw()],
  runtimeOverrides = {},
  capability = true,
  withPlan = false,
  withBackground = false,
  backgroundCompletedAt = NOW - 30_000,
  planOverrides = {},
  planRuntimeOverrides = {},
  disconnected = false,
  diagnostics = [],
  extra = {},
} = {}) {
  const smart = parseRuntime(mkRuntimeRaw(sessionId, `rt-${sessionId}`, runtimeOverrides));
  const agents = parseAgents({
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    runtimeId: `rt-${sessionId}`,
    generation: 0,
    updatedAt: NOW - 1_000,
    jobs,
  });
  const runtimes = [smart.public];
  const plans = [];
  if (withPlan) {
    const planRt = parseRuntime({
      schemaVersion: SCHEMA_VERSION,
      source: 'plan-mode',
      sessionId,
      runtimeId: `rt-plan-${sessionId}`,
      generation: 0,
      state: 'active',
      startedAt: NOW - 120_000,
      updatedAt: NOW - 1_000,
      heartbeatAt: NOW - 1_000,
      ...planRuntimeOverrides,
    });
    runtimes.push(planRt.public);
    plans.push(parsePlan({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      runtimeId: `rt-plan-${sessionId}`,
      generation: 0,
      state: 'active',
      reason: 'refining architecture',
      since: NOW - 60_000,
      updatedAt: NOW - 1_000,
      heartbeatAt: NOW - 1_000,
      ...planOverrides,
    }));
  }
  const backgroundsList = [];
  if (withBackground) {
    const backgroundRuntimeId = `rt-bg-${sessionId}`;
    runtimes.push(parseRuntime({
      schemaVersion: SCHEMA_VERSION,
      source: 'background-tasks',
      sessionId,
      runtimeId: backgroundRuntimeId,
      generation: 0,
      state: 'active',
      startedAt: NOW - 120_000,
      updatedAt: NOW - 1_000,
      heartbeatAt: NOW - 1_000,
      jobs: { total: 1, active: 1 },
    }).public);
    backgroundsList.push(parseBackgroundTasks({
      schemaVersion: SCHEMA_VERSION,
      sessionId,
      runtimeId: backgroundRuntimeId,
      generation: 0,
      revision: 6,
      updatedAt: NOW - 1_000,
      tasks: [
        { id: 'benchmark', name: 'benchmark', status: 'in_progress', position: 0, updatedAt: NOW - 60_000, runId: 'bg-run-1' },
        { id: 'analyze', name: 'analyze', status: 'pending', position: 1, updatedAt: NOW - 60_000 },
        { id: 'done', name: 'done', status: 'completed', position: 2, updatedAt: backgroundCompletedAt },
      ],
      runs: [{
        id: 'bg-run-1', taskId: 'benchmark', name: 'benchmark', status: 'running', stopping: false,
        createdAt: NOW - 70_000, startedAt: NOW - 60_000, lastOutputAt: NOW - 5_000, timeoutAt: NOW + 60_000,
      }],
    }));
  }
  const capabilities = {};
  if (capability && smart.capability) capabilities[`${sessionId}/rt-${sessionId}`] = smart.capability;
  return {
    cacheKey: 'm::w',
    disconnected,
    snapshot: { sessions: { [sessionId]: { runtimes, agentsList: [agents], plans, backgroundsList } } },
    capabilities,
    pendingRequests: {},
    diagnostics,
    lastSuccessAt: NOW - 1_000,
    ...extra,
  };
}

// ============================================================================
// escaping helpers
// ============================================================================

describe('escape helpers', () => {
  it('escapes html and attribute values', () => {
    const evil = '<script>alert("x & y")</script><img src=x onerror=alert(1)>';
    const html = escapeHtml(evil);
    assert.ok(!html.includes('<'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&amp;'));
    const attr = escapeAttr(evil);
    assert.ok(attr.includes('&quot;'));
    assert.ok(!attr.includes('"'));
  });

  it('truncateText bounds long values', () => {
    assert.equal(truncateText('abcdef', 3), 'abc…');
    assert.equal(truncateText('abc', 3), 'abc');
    assert.equal(truncateText(undefined, 5), '');
    assert.equal(truncateText(null, 5), '');
  });
});

// ============================================================================
// pure presentation helpers
// ============================================================================

describe('presentations', () => {
  it('jobStatusPresentation maps every status to a clear label + tone', () => {
    const expected = {
      pending: 'info',
      in_progress: 'live',
      routing: 'info',
      queued: 'info',
      running: 'live',
      stopping: 'warn',
      stale: 'warn',
      completed: 'ok',
      failed: 'danger',
      blocked: 'warn',
      cancelled: 'muted',
      stopped: 'muted',
    };
    for (const [status, tone] of Object.entries(expected)) {
      const p = jobStatusPresentation({ status });
      assert.equal(p.label, status);
      assert.equal(p.tone, tone);
    }
    assert.equal(jobStatusPresentation({ status: 'weird' }).tone, 'muted');
    const disc = jobStatusPresentation({ status: 'running' }, true);
    assert.equal(disc.label, 'running · last known');
    assert.equal(disc.tone, 'disconnected');
    assert.equal(jobStatusPresentation(null).label, 'idle');
  });

  it('smartStatusPresentation and planChipPresentation', () => {
    assert.deepEqual(smartStatusPresentation('active'), { label: 'smart · live', tone: 'live' });
    assert.equal(smartStatusPresentation('stale').label, 'smart · stale');
    assert.equal(smartStatusPresentation('shutdown').tone, 'danger');
    assert.equal(smartStatusPresentation('idle').label, 'no smart runtime');
    assert.deepEqual(backgroundStatusPresentation('active'), { label: 'monitor · live', tone: 'live' });
    assert.equal(backgroundStatusPresentation('stale').label, 'monitor · stale');
    assert.equal(backgroundStatusPresentation('shutdown').tone, 'danger');

    const chip = planChipPresentation({ state: 'active', reason: 'refining architecture', since: NOW - 60_000, runtimeStatus: 'active' }, NOW);
    assert.equal(chip.stateLabel, '');
    assert.equal(chip.tone, 'live');
    assert.equal(chip.sinceText, '1m ago');
    assert.equal(chip.reason, 'refining architecture');
    assert.equal(planChipPresentation({ state: 'active', runtimeStatus: 'stale', reason: 'x', since: NOW - 1_000 }, NOW).stateLabel, 'stale');
    assert.equal(planChipPresentation({ state: 'active', runtimeStatus: 'shutdown', reason: 'x', since: NOW - 1_000 }, NOW).stateLabel, 'shut down');
    assert.equal(planChipPresentation({ state: 'inactive', runtimeStatus: 'active' }, NOW), null);
    assert.equal(planChipPresentation(null, NOW), null);
  });

  it('stop unavailability reasons cover stale/shutdown/no capability/pending/disconnected', () => {
    const session = { sessionId: 's', stopPending: false, stop: { available: true }, activeCount: 1, smartStatus: 'active' };
    assert.equal(stopUnavailableReasonForSession(session, false), '');
    assert.match(stopUnavailableReasonForSession({ ...session, smartStatus: 'stale' }), /stale/);
    assert.match(stopUnavailableReasonForSession({ ...session, smartStatus: 'shutdown' }), /shut down/);
    assert.match(stopUnavailableReasonForSession({ ...session, stopPending: true }), /already pending/);
    assert.match(stopUnavailableReasonForSession({ ...session, stop: null }), /no smart runtime/);
    assert.match(stopUnavailableReasonForSession({ ...session, stop: { available: false } }), /capability/);
    assert.match(stopUnavailableReasonForSession(session, true), /disconnected/);

    const job = { id: 'j1', backendStatus: 'completed', canStop: false };
    assert.match(stopUnavailableReasonForJob(job, session), /not active/);
    assert.match(stopUnavailableReasonForJob({ id: 'j1', backendStatus: 'running', canStop: false }, { ...session, stop: null }), /no smart runtime/);
    assert.equal(stopUnavailableReasonForJob({ id: 'j1', backendStatus: 'running', canStop: true }, session), '');
  });

  it('confirmStopAllMessage names the session', () => {
    assert.equal(confirmStopAllMessage('sess1'), 'Stop all active sub-agent job(s) in session sess1?');
    assert.equal(confirmStopAllMessage('sess1', 3), 'Stop all 3 active sub-agent job(s) in session sess1?');
  });
});

// ============================================================================
// renderActivityPanelHtml — structure
// ============================================================================

describe('renderActivityPanelHtml — structure', () => {
  it('renders empty states safely', () => {
    assert.ok(renderActivityPanelHtml(null, {}).includes('Select a workspace.'));
    const empty = renderActivityPanelHtml({
      disconnected: false, now: NOW, totalActive: 0, badge: '',
      sessions: [], diagnostics: [], errors: [], lastSuccessAt: null,
    }, {});
    assert.ok(empty.includes('>Activity<'));
    assert.ok(empty.includes('data-refresh'));
    assert.ok(empty.includes('No activity records'));
    assert.ok(!empty.includes('Stop agents'));
  });

  it('renders a representative active session (toolbar, badge, chips, fields, details)', () => {
    const view = buildViewModel(viewState({ withPlan: true }), 'sess1', NOW);
    const html = renderActivityPanelHtml(view, {});
    // toolbar: title, total-active badge, manual refresh
    assert.ok(html.includes('>Activity<'));
    assert.ok(html.includes('data-refresh'));
    assert.ok(html.includes('aria-label="1 active job"'));
    // selected session highlight
    assert.ok(html.includes('class="session selected"'));
    assert.ok(html.includes('data-session-id="sess1"'));
    assert.ok(html.includes('aria-current="true"'));
    // smart liveness + PLAN chip with reason/since
    assert.ok(html.includes('smart · live'));
    assert.ok(html.includes('PLAN · since 1m ago · refining architecture'));
    assert.ok(html.includes('1 active'));
    // stop controls with exact ids
    assert.ok(html.includes('data-stop-all="sess1"'));
    assert.ok(!html.includes('data-stop-all="sess1" disabled'), 'stop all enabled when fresh');
    assert.ok(html.includes('>Stop agents<'));
    assert.ok(html.includes('data-stop-one="j1"'));
    assert.ok(html.includes('data-session-id="sess1"'));
    assert.ok(!html.includes('data-stop-one="j1" disabled'), 'stop one enabled when fresh');
    // job card: status, name, model, thinking, elapsed, progress age, timeout
    assert.ok(html.includes('status-chip tone-live">running<'));
    assert.ok(html.includes('Deploy preview'));
    assert.ok(html.includes(`<span class="field-label">elapsed</span> ${formatDuration(60_000)}`));
    assert.ok(html.includes('<span class="field-label">progress</span> 8s ago'));
    assert.ok(html.includes('<code>gpt-5</code>'));
    assert.ok(html.includes('<span class="field-label">thinking</span> high'));
    assert.ok(html.includes('timeout'));
    // fold details for progress / changed files / result / log path
    assert.ok(html.includes('<details data-detail-id="progress-sess1-j1"'));
    assert.ok(html.includes('Progress (2)'));
    assert.ok(html.includes('Changed files (1)'));
    assert.ok(html.includes('Result'));
    assert.ok(html.includes('preview deployed'));
    assert.ok(html.includes('Log path'));
    assert.ok(html.includes('/tmp/j1.log'));
  });

  it('renders dynamic main-agent task plan and managed background runs', () => {
    const view = buildViewModel(viewState({ withBackground: true }), 'sess1', NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(html.includes('aria-label="2 active jobs"'));
    assert.ok(html.includes('Main-agent Tasks · revision 6'));
    assert.ok(html.includes('monitor · live'));
    assert.ok(html.includes('class="task-plan"'));
    assert.ok(html.includes('benchmark'));
    assert.ok(html.includes('in_progress'));
    assert.ok(html.includes('analyze'));
    assert.ok(html.includes('pending'));
    assert.ok(html.includes('done'));
    assert.ok(html.includes('completed'));
    assert.ok(html.includes('Managed runs'));
    assert.ok(html.includes('background-run-card'));
    assert.ok(html.includes('task <code>benchmark</code>'));
    assert.ok(html.includes('<span class="field-label">progress</span> 5s ago'));
    // Background records are display-only in v1; only the smart job owns Stop.
    assert.equal((html.match(/data-stop-one=/g) ?? []).length, 1);
  });

  it('removes a completed task row at the 60s display boundary', () => {
    const recent = renderActivityPanelHtml(
      buildViewModel(viewState({ withBackground: true, backgroundCompletedAt: NOW - 59_999 }), null, NOW),
      {},
    );
    const expired = renderActivityPanelHtml(
      buildViewModel(viewState({ withBackground: true, backgroundCompletedAt: NOW - 60_000 }), null, NOW),
      {},
    );
    assert.ok(recent.includes('<code class="task-id">done</code>'));
    assert.ok(!expired.includes('<code class="task-id">done</code>'));
    assert.ok(expired.includes('<code class="task-id">analyze</code>'), 'pending task remains visible');
  });

  it('stale runtime: job shows stale, all stop controls disabled with a reason', () => {
    const view = buildViewModel(viewState({ runtimeOverrides: { heartbeatAt: NOW - 60_000 } }), null, NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(html.includes('status-chip tone-warn">stale<'));
    assert.ok(html.includes('smart · stale'));
    assert.ok(html.includes('data-stop-all="sess1" disabled'));
    assert.ok(html.includes('smart runtime is stale'));
    assert.ok(html.includes('data-stop-one="j1" disabled'));
  });

  it('shutdown runtime disables controls', () => {
    const view = buildViewModel(viewState({ runtimeOverrides: { state: 'shutdown' } }), null, NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(html.includes('smart · shut down'));
    assert.ok(html.includes('smart runtime has shut down'));
    assert.ok(html.includes('data-stop-all="sess1" disabled'));
  });

  it('missing capability disables controls', () => {
    const view = buildViewModel(viewState({ capability: false }), null, NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(html.includes('no control capability'));
    assert.ok(html.includes('data-stop-all="sess1" disabled'));
    assert.ok(html.includes('data-stop-one="j1" disabled'));
  });

  it('pending stop_all disables every stop control and shows stopping', () => {
    const state = viewState();
    state.pendingRequests = {
      'sess1/rt-sess1/req1': {
        sessionId: 'sess1', runtimeId: 'rt-sess1', requestId: 'req1', status: 'pending',
        publishedAt: NOW, expiresAt: NOW + 5_000,
        envelope: {
          schemaVersion: SCHEMA_VERSION, sessionId: 'sess1', runtimeId: 'rt-sess1',
          generation: 0, controlToken: 'secret-token-rt-sess1', requestId: 'req1',
          action: 'stop_all', createdAt: NOW, expiresAt: NOW + 5_000,
        },
      },
    };
    const view = buildViewModel(state, null, NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(html.includes('data-stop-all="sess1" disabled'));
    assert.ok(html.includes('already pending'));
    assert.ok(html.includes('status-chip tone-warn">stopping<'));
    assert.ok(html.includes('data-stop-one="j1" disabled'));
    // the envelope (and its token) is never rendered
    assert.ok(!html.includes('secret-token-rt-sess1'));
    assert.ok(!html.includes('controlToken'));
  });

  it('disconnected banner explicitly says showing last known state and disables controls', () => {
    const view = buildViewModel(viewState({ disconnected: true }), null, NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(html.includes('Disconnected from activity records — showing the last known state.'));
    assert.ok(html.includes('status-chip tone-disconnected">running · last known<'));
    assert.ok(html.includes('data-stop-all="sess1" disabled'));
    assert.ok(html.includes('data-stop-one="j1" disabled'));
    assert.ok(html.includes('disconnected'));
  });

  it('renders clear chips for every job status plus queue position', () => {
    const statuses = ['routing', 'queued', 'running', 'stopping', 'completed', 'failed', 'stopped'];
    const jobs = statuses.map((status, i) => mkJobRaw({
      id: `j${i}`,
      status: status === 'stopping' ? 'running' : status,
      stopping: status === 'stopping',
      queuePosition: status === 'queued' ? 2 : undefined,
      startedAt: status === 'queued' || status === 'routing' ? undefined : NOW - 1_000,
      finishedAt: ['completed', 'failed', 'stopped'].includes(status) ? NOW - 500 : undefined,
    }));
    const view = buildViewModel(viewState({ jobs }), null, NOW);
    const html = renderActivityPanelHtml(view, {});
    const expected = {
      routing: ['status-chip tone-info">routing<'],
      queued: ['status-chip tone-info">queued<'],
      running: ['status-chip tone-live">running<'],
      stopping: ['status-chip tone-warn">stopping<'],
      completed: ['status-chip tone-ok">completed<'],
      failed: ['status-chip tone-danger">failed<'],
      stopped: ['status-chip tone-muted">stopped<'],
    };
    for (const [status, needles] of Object.entries(expected)) {
      for (const needle of needles) assert.ok(html.includes(needle), `${status} → ${needle}`);
    }
    assert.ok(html.includes('<span class="field-label">queue</span> #2'));
  });

  it('renders timeout states (timed out and future deadline)', () => {
    const timedOut = buildViewModel(viewState({ jobs: [mkJobRaw({ timeoutAt: NOW - 1_000 })] }), null, NOW);
    assert.ok(renderActivityPanelHtml(timedOut, {}).includes('timed out'));
    const future = buildViewModel(viewState({ jobs: [mkJobRaw({ timeoutAt: NOW + 60_000 })] }), null, NOW);
    const html = renderActivityPanelHtml(future, {});
    assert.ok(html.includes('<span class="field-label">timeout</span> in 1m'));
  });

  it('bounds rendered errors and diagnostics', () => {
    const uiErrors = Array.from({ length: 30 }, (_, i) => ({ message: `error ${i}`, at: NOW }));
    const diagnostics = Array.from({ length: 60 }, (_, i) => ({ level: 'warn', message: `diag ${i}`, at: NOW }));
    const view = buildViewModel(viewState({ diagnostics }), null, NOW, { uiErrors });
    const html = renderActivityPanelHtml(view, {});
    assert.equal((html.match(/class="error"/g) || []).length, MAX_RENDERED_ERRORS);
    assert.equal((html.match(/diag-message/g) || []).length, MAX_RENDERED_DIAGNOSTICS);
    assert.ok(html.includes(`Diagnostics (${MAX_RENDERED_DIAGNOSTICS})`));
    // most recent first
    assert.ok(html.indexOf('error 29') < html.indexOf('error 28'));
  });

  it('preserves open detail folds via the detailsOpen option', () => {
    const view = buildViewModel(viewState(), null, NOW);
    const html = renderActivityPanelHtml(view, { detailsOpen: new Set(['progress-sess1-j1']) });
    assert.ok(html.includes('data-detail-id="progress-sess1-j1" open'));
    const closed = renderActivityPanelHtml(view, {});
    assert.ok(!closed.includes('data-detail-id="progress-sess1-j1" open'));
  });

  it('renders aria-live feedback and errors regions', () => {
    const view = buildViewModel(viewState(), null, NOW);
    const html = renderActivityPanelHtml(view, { feedback: { kind: 'ok', text: 'Stop all request sent.' } });
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(html.includes('feedback-ok'));
    assert.ok(html.includes('Stop all request sent.'));
    const withError = buildViewModel(viewState(), null, NOW, { uiErrors: [{ message: 'boom', at: NOW }] });
    const errorHtml = renderActivityPanelHtml(withError, {});
    assert.ok(errorHtml.includes('aria-live="polite"'));
    assert.ok(errorHtml.includes('boom'));
  });

  it('renders sessions in view-model order (active first, nothing hidden)', () => {
    const a = buildViewModel(viewState({ sessionId: 'sess-a' }), null, NOW);
    const b = buildViewModel(viewState({ sessionId: 'sess-b', jobs: [mkJobRaw({ status: 'completed', finishedAt: NOW - 500 })] }), null, NOW);
    const combined = {
      disconnected: false,
      now: NOW,
      totalActive: 1,
      badge: '1',
      sessions: [a.sessions[0], b.sessions[0]].reverse(), // deliberately active-last input
      diagnostics: [],
      errors: [],
      lastSuccessAt: NOW,
    };
    const html = renderActivityPanelHtml(combined, {});
    const posA = html.indexOf('data-session-id="sess-a"');
    const posB = html.indexOf('data-session-id="sess-b"');
    assert.ok(posA >= 0 && posB >= 0, 'both sessions rendered');
    assert.ok(posB < posA, 'input order preserved (view model owns grouping)');
  });
});

// ============================================================================
// XSS + secrecy
// ============================================================================

describe('renderActivityPanelHtml — XSS and secrecy', () => {
  it('escapes every dynamic value and never leaks secrets', () => {
    const evil = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    const evilSession = '"><img src=x onerror=alert(1)>';
    const view = {
      disconnected: false,
      now: NOW,
      totalActive: 1,
      badge: '1',
      sessions: [{
        sessionId: evilSession,
        selected: true,
        status: 'active',
        smartStatus: 'active',
        active: true,
        activeCount: 1,
        badge: '1',
        hasRuntime: true,
        primarySource: 'smart-subagents',
        primaryGeneration: 0,
        plan: { state: 'active', reason: evil, since: NOW - 1_000, runtimeStatus: 'active' },
        background: {
          revision: evil,
          runtimeStatus: 'active',
          activeCount: 1,
          tasks: [{ id: evil, name: evil, status: evil, position: 0, updatedAt: NOW, runId: evil }],
          runs: [{
            id: evil, taskId: evil, name: evil, status: evil, backendStatus: 'running', stopping: false,
            elapsed: 1_000, progressAge: 500, timedOut: false, timeoutAt: NOW + 1_000,
            exitCode: null, signal: evil, terminationReason: evil, canStop: false,
          }],
        },
        jobs: [{
          id: '"><img onerror=alert(1)>',
          name: evil,
          status: 'running',
          backendStatus: 'running',
          stopping: false,
          queuePosition: 1,
          model: evil,
          modelName: evil,
          providerName: evil,
          thinking: evil,
          context: evil,
          permission: evil,
          elapsed: 1_000,
          queueAge: 1_000,
          progressAge: 500,
          timedOut: false,
          timeoutAt: NOW + 1_000,
          progress: [evil],
          changedFiles: [evil],
          resultSummary: evil,
          errorSummary: evil,
          logPath: evil,
          canStop: true,
        }],
        stop: { available: true, sessionId: evilSession, runtimeId: 'r', generation: 0 },
        stopPending: false,
      }],
      diagnostics: [{ level: 'error', message: evil, at: NOW }],
      errors: [{ message: evil, at: NOW }],
      lastSuccessAt: NOW,
    };
    const html = renderActivityPanelHtml(view, {});
    // No unescaped markup survives anywhere.
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes('&quot;&gt;&lt;img'), 'attribute breakout neutralized');
    // Never token/task/context/live output/raw store internals.
    for (const forbidden of ['controlToken', 'secret-token-', 'capabilities', 'pendingRequests', 'envelope', 'FULL SECRET TASK', 'LIVE OUTPUT', 'PARENT CONTEXT']) {
      assert.ok(!html.includes(forbidden), forbidden);
    }
    assert.ok(!/\bpid\b/i.test(html));
  });

  it('renders a real (parsed) malicious job name safely', () => {
    const evil = '"><img src=x onerror=alert(1)>';
    const state = viewState({ jobs: [mkJobRaw({ name: evil, progress: [evil], logPath: evil, resultSummary: evil })] });
    const view = buildViewModel(state, null, NOW);
    const html = renderActivityPanelHtml(view, {});
    assert.ok(!html.includes('<img'));
    assert.ok(html.includes('&lt;img'));
    assert.ok(!html.includes('secret-token-rt-sess1'), 'control token never rendered');
  });
});

// ============================================================================
// styles: touch / mobile / motion / focus requirements
// ============================================================================

describe('activityStyles', () => {
  it('enforces touch, mobile, motion and focus requirements', () => {
    const css = activityStyles();
    assert.ok(css.includes('min-height: 44px'));
    assert.ok(css.includes('min-width: 44px'));
    assert.ok(css.includes('@media (max-width: 760px)'));
    assert.ok(css.includes('prefers-reduced-motion'));
    assert.ok(css.includes(':focus-visible'));
    assert.ok(!css.includes(':hover'), 'no hover-dependent interactions');
    for (const tone of ['tone-live', 'tone-ok', 'tone-info', 'tone-warn', 'tone-danger', 'tone-muted', 'tone-disconnected']) {
      assert.ok(css.includes(tone), tone);
    }
    // semantic, touch-sized summaries for fold details
    assert.ok(css.includes('summary { cursor: pointer; min-height: 44px'));
  });
});

// ============================================================================
// shared controller cache
// ============================================================================

describe('controller cache', () => {
  it('keys by exact machine/project/workspace', () => {
    const context = { machine: { id: 'm1' }, workspace: { projectId: 'p1', id: 'w1' } };
    assert.equal(controllerCacheKeyForContext(context), 'm1:p1:w1');
    assert.equal(controllerCacheKeyForContext({ ...context, workspace: { projectId: 'p2', id: 'w1' } }), 'm1:p2:w1');
    assert.equal(controllerCacheKeyForContext({ ...context, machine: { id: 'm2' } }), 'm2:p1:w1');
    assert.equal(controllerCacheKeyForContext(undefined), '::');
    assert.equal(controllerCacheKeyForContext({}), '::');
  });

  it('shares one controller per context and starts it on first access', () => {
    const started = [];
    const previous = setActivityControllerFactory((context) => ({
      start() { started.push(controllerCacheKeyForContext(context)); return Promise.resolve(); },
      stop() {},
      setVisible() { return Promise.resolve(); },
      refreshNow() { return Promise.resolve(); },
      getView() { return null; },
      subscribe() { return () => {}; },
    }));
    try {
      const context = { machine: { id: 'm1' }, workspace: { projectId: 'p1', id: 'w1' }, files: {}, host: { requestRender() {} } };
      const first = getControllerForContext(context);
      const second = getControllerForContext(context);
      assert.equal(first, second);
      assert.equal(controllerCacheSize(), 1);
      assert.deepEqual(started, ['m1:p1:w1']);
      assert.equal(activityPanelBadge(context), undefined); // null view → no badge
      assert.deepEqual(activityWorkspaceLabelItems(context), []);
    } finally {
      resetActivityControllerCache();
      setActivityControllerFactory(previous);
    }
  });

  it('caps the cache and stops evicted controllers (LRU)', () => {
    const controllers = [];
    const previous = setActivityControllerFactory(() => {
      const controller = {
        stopped: false,
        start() { return Promise.resolve(); },
        stop() { this.stopped = true; },
        setVisible() { return Promise.resolve(); },
        refreshNow() { return Promise.resolve(); },
        getView() { return null; },
        subscribe() { return () => {}; },
      };
      controllers.push(controller);
      return controller;
    });
    try {
      const makeContext = (i) => ({
        machine: { id: 'm' }, workspace: { projectId: `p${i}`, id: `w${i}` },
        files: {}, host: { requestRender() {} },
      });
      for (let i = 0; i < CONTROLLER_CACHE_MAX; i++) getControllerForContext(makeContext(i));
      assert.equal(controllerCacheSize(), CONTROLLER_CACHE_MAX);
      assert.ok(controllers.every((c) => !c.stopped));
      // Touch the oldest entry → it becomes most-recent.
      getControllerForContext(makeContext(0));
      for (let i = CONTROLLER_CACHE_MAX; i < CONTROLLER_CACHE_MAX + 5; i++) getControllerForContext(makeContext(i));
      assert.equal(controllerCacheSize(), CONTROLLER_CACHE_MAX);
      for (let i = 1; i <= 5; i++) assert.equal(controllers[i].stopped, true, `controller ${i} stopped on eviction`);
      assert.equal(controllers[0].stopped, false, 'recently used controller survives');
      assert.equal(controllers[24].stopped, false);
    } finally {
      resetActivityControllerCache();
      setActivityControllerFactory(previous);
    }
  });

  it('throws without files and host', () => {
    assert.throws(() => getControllerForContext({}), /files and host/);
  });
});

// ============================================================================
// badge + label callbacks (real controller + fake files)
// ============================================================================

describe('badge and label callbacks', () => {
  const fakeHost = () => ({ renders: 0, requestRender() { this.renders += 1; } });

  it('badge reflects the active job count after the first refresh', async () => {
    const { files, sessionId } = smartSessionFiles();
    const context = {
      machine: { id: 'm1' }, workspace: { projectId: 'p1', id: 'w1' },
      files: createFakeFiles(files), host: fakeHost(), state: { selectedSession: sessionId },
    };
    try {
      const controller = getControllerForContext(context); // first access starts polling
      await controller.refreshNow();
      assert.equal(activityPanelBadge(context), '1');
      const items = activityWorkspaceLabelItems(context);
      assert.ok(items.some((i) => i.text === '1 active'));
    } finally {
      resetActivityControllerCache();
    }
  });

  it('labels report plan activity and the disconnected state', async () => {
    const { files, sessionId } = smartSessionFiles({ withPlan: true });
    const context = {
      machine: { id: 'm1' }, workspace: { projectId: 'p1', id: 'w1' },
      files: createFakeFiles(files), host: fakeHost(), state: { selectedSession: sessionId },
    };
    try {
      const controller = getControllerForContext(context);
      await controller.refreshNow();
      const items = activityWorkspaceLabelItems(context);
      assert.ok(items.some((i) => i.text === 'plan · sess1'));
      assert.ok(!items.some((i) => i.text.includes('last known')));
    } finally {
      resetActivityControllerCache();
    }
  });

  it('disconnected workspace → last-known label and no badge', async () => {
    const failingFiles = {
      listFiles: async () => { const e = new Error('connection refused'); e.code = 'ECONNREFUSED'; throw e; },
      readFile: async () => { throw new Error('unused'); },
    };
    const context = {
      machine: { id: 'm1' }, workspace: { projectId: 'p1', id: 'w1' },
      files: failingFiles, host: fakeHost(),
    };
    try {
      const controller = getControllerForContext(context);
      await controller.refreshNow();
      assert.equal(activityPanelBadge(context), undefined);
      assert.ok(activityWorkspaceLabelItems(context).some((i) => i.text.includes('last known')));
    } finally {
      resetActivityControllerCache();
    }
  });

  it('badge/label return safe defaults for unusable contexts', () => {
    assert.equal(activityPanelBadge(undefined), undefined);
    assert.equal(activityPanelBadge({}), undefined);
    assert.deepEqual(activityWorkspaceLabelItems(undefined), []);
    assert.deepEqual(activityWorkspaceLabelItems({}), []);
  });
});

// ============================================================================
// source wiring (static checks — no DOM libraries)
// ============================================================================

describe('source wiring (static)', () => {
  const source = readFileSync(fileURLToPath(new URL('./activity-panel.js', import.meta.url)), 'utf8');

  it('uses only the public files/host APIs', () => {
    assert.ok(source.includes('context.files'));
    assert.ok(source.includes('context.host'));
    assert.ok(!source.includes('context.backend'));
    assert.ok(!source.includes('context.terminal'));
    assert.ok(!source.includes('fetch('));
    assert.ok(!source.includes('XMLHttpRequest'));
    assert.ok(!source.includes('WebSocket'));
  });

  it('stop handlers dispatch exact ids to the controller', () => {
    assert.ok(source.includes(`querySelectorAll('button[data-stop-one]')`));
    assert.ok(source.includes(`getAttribute('data-session-id')`));
    assert.ok(source.includes(`getAttribute('data-stop-one')`));
    assert.ok(source.includes(`querySelectorAll('button[data-stop-all]')`));
    assert.ok(source.includes(`getAttribute('data-stop-all')`));
    assert.ok(source.includes('controller.stopOne('));
    assert.ok(source.includes('controller.stopAll('));
  });

  it('panel disconnect only unsubscribes (never stops the shared controller)', () => {
    const region = source.match(/disconnectedCallback\(\)\s*\{([^}]*)\}/);
    assert.ok(region, 'disconnectedCallback defined');
    assert.ok(!region[1].includes('.stop('));
  });

  it('Stop all confirmation fails closed when the confirm API is unavailable', () => {
    assert.match(source, /return false; \/\/ no confirm API: fail closed/);
  });

  it('defineActivityPanelElement is guarded outside a DOM environment', () => {
    assert.equal(activityPanelTagName, 'pi-web-activity-panel');
    // In Node there is no customElements registry — must return false, not throw.
    assert.equal(defineActivityPanelElement(), false);
  });
});
