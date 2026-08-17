// activity-panel.js — Browser DOM/UI layer for the PI WEB Activity plugin.
// Dependency-free custom element <pi-web-activity-panel> patterned after the
// bundled workspace-tasks panel. Consumes only the tested controller / view
// model and the public context.files + context.host APIs (plus machine/
// workspace ids for the shared controller cache). Never uses REST, backend,
// terminal or private DOM, and never renders raw store state, capabilities,
// control tokens, PIDs, full task text, context or live output.
//
// Secrecy contract: the panel renders ONLY the view model produced by
// buildViewModel(). Every dynamic value passes through escapeHtml/escapeAttr
// before innerHTML. The shared controller cache owns the controllers (which
// hold the private capability map) — the DOM layer never reads internals.
//
// Exports:
//   defineActivityPanelElement()        registers <pi-web-activity-panel>
//   activityPanelBadge(context)         badge for the panel contribution
//   activityWorkspaceLabelItems(ctx)    label items for the labels contribution
//   renderActivityPanelHtml(view, opts) pure HTML render (testable, no DOM)
//   activityStyles()                    pure CSS string (testable)
//   presentation/escape/confirm helpers + controller cache helpers.

import { createActivityController } from './activity-controller.js';
import { formatDuration, formatRelative } from './activity-view-model.js';
import { isActiveJobStatus } from './activity-schema.js';

export const activityPanelTagName = 'pi-web-activity-panel';
export const CONTROLLER_CACHE_MAX = 20;
export const MAX_RENDERED_ERRORS = 5;
export const MAX_RENDERED_DIAGNOSTICS = 20;

// ---- escaping (every dynamic value passes through these before innerHTML) --

export function escapeHtml(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function escapeAttr(value) {
  return escapeHtml(value).replaceAll('"', '&quot;');
}

export function truncateText(value, max) {
  const s = String(value ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}

// ---- shared controller cache ------------------------------------------------
// Keyed by exact machine + projectId + workspace id. Capped at
// CONTROLLER_CACHE_MAX controllers; the least-recently-used controller is
// stopped on eviction (no timer leaks). Controllers are created with ONLY the
// public context.files + context.host APIs and start immediate 1s polling on
// first badge/label/panel access.

const controllerCache = new Map();
let controllerFactory = null; // test seam (setActivityControllerFactory)
let globalListenersBound = false;

export function controllerCacheKeyForContext(context) {
  const machineId = context && context.machine && typeof context.machine === 'object'
    ? String(context.machine.id ?? '') : '';
  const projectId = context && context.workspace && typeof context.workspace === 'object'
    ? String(context.workspace.projectId ?? '') : '';
  const workspaceId = context && context.workspace && typeof context.workspace === 'object'
    ? String(context.workspace.id ?? '') : '';
  return `${machineId}:${projectId}:${workspaceId}`;
}

export function controllerCacheSize() {
  return controllerCache.size;
}

/** Test seam: replace the controller factory. Returns the previous factory. */
export function setActivityControllerFactory(factory) {
  const previous = controllerFactory;
  controllerFactory = factory;
  return previous;
}

/** Stop every cached controller and clear the cache (teardown/tests). */
export function resetActivityControllerCache() {
  for (const entry of controllerCache.values()) {
    try { entry.controller.stop(); } catch (_) { /* best-effort */ }
  }
  controllerCache.clear();
}

function defaultCreateController(context) {
  return createActivityController({
    files: context.files,
    machine: context.machine,
    workspace: context.workspace,
    host: context.host,
  });
}

export function trimControllerCache() {
  while (controllerCache.size > CONTROLLER_CACHE_MAX) {
    const oldestKey = controllerCache.keys().next().value;
    if (oldestKey === undefined) break;
    const entry = controllerCache.get(oldestKey);
    controllerCache.delete(oldestKey);
    try { entry.controller.stop(); } catch (_) { /* best-effort */ }
  }
}

/**
 * getControllerForContext(context) — the one shared controller for the exact
 * machine/project/workspace key. First access creates it and starts the
 * immediate 1s polling loop (respecting page visibility).
 */
export function getControllerForContext(context) {
  if (!context || !context.files || !context.host) {
    throw new Error('getControllerForContext: context with files and host is required');
  }
  ensureGlobalListeners();
  const key = controllerCacheKeyForContext(context);
  const cached = controllerCache.get(key);
  if (cached) {
    // LRU touch: re-insert to move this entry to the most-recent end.
    controllerCache.delete(key);
    controllerCache.set(key, cached);
    return cached.controller;
  }
  const create = controllerFactory || defaultCreateController;
  const controller = create(context);
  controllerCache.set(key, { key, controller });
  trimControllerCache();
  void Promise.resolve(controller.start()).catch(() => { /* errors surface via the view */ });
  if (isDocumentHidden()) void controller.setVisible(false);
  return controller;
}

// ---- page visibility (bound once, guarded for non-DOM environments) ---------

function isDocumentHidden() {
  try {
    return typeof document !== 'undefined' && document.hidden === true;
  } catch (_) { return false; }
}

function forEachCachedController(fn) {
  for (const entry of controllerCache.values()) {
    try { fn(entry.controller); } catch (_) { /* best-effort */ }
  }
}

function onVisibilityChange() {
  if (isDocumentHidden()) {
    forEachCachedController((controller) => { void controller.setVisible(false); });
  } else {
    forEachCachedController((controller) => {
      void controller.setVisible(true);
      void controller.refreshNow();
    });
  }
}

function onPageShow() {
  forEachCachedController((controller) => {
    void controller.setVisible(true);
    void controller.refreshNow();
  });
}

/** Bind page-visibility listeners exactly once (guarded, idempotent). */
export function ensureGlobalListeners() {
  if (globalListenersBound) return;
  globalListenersBound = true;
  try {
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pageshow', onPageShow);
    }
  } catch (_) { /* never let listener setup break rendering */ }
}

// ---- host contribution callbacks -------------------------------------------

function selectedSessionOf(context) {
  return context && context.state ? context.state.selectedSession : undefined;
}

/** Badge for the workspace panel contribution: active job count, else none. */
export function activityPanelBadge(context) {
  if (!context || !context.files || !context.host) return undefined;
  try {
    ensureGlobalListeners();
    const controller = getControllerForContext(context);
    const view = controller.getView(selectedSessionOf(context));
    if (!view || view.badge === '' || view.badge == null) return undefined;
    return String(view.badge);
  } catch (_) {
    return undefined;
  }
}

/** Label items for the workspace labels contribution (bounded, plain text). */
export function activityWorkspaceLabelItems(context) {
  if (!context || !context.files || !context.host) return [];
  try {
    ensureGlobalListeners();
    const controller = getControllerForContext(context);
    const view = controller.getView(selectedSessionOf(context));
    if (!view) return [];
    const items = [];
    if (view.disconnected) {
      items.push({
        type: 'text',
        text: 'activity · last known state',
        title: 'Activity monitor is disconnected — showing the last known state.',
      });
    }
    if (view.totalActive > 0) {
      items.push({ type: 'text', text: `${view.totalActive} active`, title: 'Active sub-agent and main-agent background job(s) across sessions' });
    }
    const planSessions = view.sessions.filter((s) => s.plan && s.plan.state === 'active');
    for (const session of planSessions.slice(0, 3)) {
      items.push({
        type: 'text',
        text: `plan · ${truncateText(session.sessionId, 40)}`,
        title: session.plan.reason ? `Plan active: ${truncateText(session.plan.reason, 120)}` : 'Plan mode active',
      });
    }
    return items;
  } catch (_) {
    return [];
  }
}

// ---- pure presentation helpers ---------------------------------------------

export function jobStatusPresentation(job, disconnected = false) {
  const base = String(job && job.status ? job.status : 'idle');
  const tones = {
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
    idle: 'muted',
  };
  const tone = tones[base] ?? 'muted';
  if (disconnected) {
    return { label: `${base} · last known`, tone: 'disconnected' };
  }
  return { label: base, tone };
}

export function smartStatusPresentation(smartStatus) {
  switch (smartStatus) {
    case 'active': return { label: 'smart · live', tone: 'live' };
    case 'stale': return { label: 'smart · stale', tone: 'warn' };
    case 'shutdown': return { label: 'smart · shut down', tone: 'danger' };
    default: return { label: 'no smart runtime', tone: 'muted' };
  }
}

export function backgroundStatusPresentation(status) {
  switch (status) {
    case 'active': return { label: 'monitor · live', tone: 'live' };
    case 'stale': return { label: 'monitor · stale', tone: 'warn' };
    case 'shutdown': return { label: 'monitor · shut down', tone: 'danger' };
    default: return { label: 'monitor unavailable', tone: 'muted' };
  }
}

export function planChipPresentation(plan, now) {
  if (!plan || plan.state !== 'active') return null;
  const byRuntime = {
    active: { label: '', tone: 'live' },
    stale: { label: 'stale', tone: 'warn' },
    shutdown: { label: 'shut down', tone: 'danger' },
    idle: { label: 'missing runtime', tone: 'muted' },
  };
  const status = byRuntime[plan.runtimeStatus] ?? { label: String(plan.runtimeStatus ?? ''), tone: 'muted' };
  return {
    stateLabel: status.label,
    tone: status.tone,
    reason: truncateText(plan.reason ?? '', 80),
    sinceText: Number.isFinite(plan.since) ? formatRelative(plan.since, now) : '',
  };
}

export function stopUnavailableReasonForSession(session, disconnected = false) {
  if (disconnected) return 'Stop unavailable while disconnected from activity records';
  if (session.stopPending) return 'Stop request already pending';
  if (!session.stop) return 'Stop unavailable: no smart runtime owner for this session';
  if ((session.smartActiveCount ?? session.activeCount) === 0) return 'Stop unavailable: no active sub-agent jobs';
  if (session.smartStatus === 'stale') return 'Stop unavailable: smart runtime is stale';
  if (session.smartStatus === 'shutdown') return 'Stop unavailable: smart runtime has shut down';
  if (session.smartStatus === 'idle') return 'Stop unavailable: smart runtime is missing';
  if (!session.stop.available) return session.stop.reason || 'Stop unavailable: no control capability for this runtime';
  return '';
}

export function stopUnavailableReasonForJob(job, session, disconnected = false) {
  if (disconnected) return 'Stop unavailable while disconnected from activity records';
  if (session.stopPending) return 'Stop request already pending';
  if (!session.stop) return 'Stop unavailable: no smart runtime owner for this session';
  if (!isActiveJobStatus(job.backendStatus)) return `Job ${job.id} is not active`;
  if (session.smartStatus === 'stale') return 'Stop unavailable: smart runtime is stale';
  if (session.smartStatus === 'shutdown') return 'Stop unavailable: smart runtime has shut down';
  if (session.smartStatus === 'idle') return 'Stop unavailable: smart runtime is missing';
  if (!job.canStop) return session.stop.reason || 'Stop unavailable: no control capability for this runtime';
  return '';
}

export function confirmStopAllMessage(sessionId, activeCount) {
  const count = Number.isFinite(activeCount) && activeCount > 0 ? ` ${activeCount}` : '';
  return `Stop all${count} active sub-agent job(s) in session ${sessionId}?`;
}

function guardedConfirm(message) {
  try {
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      return window.confirm(message) === true;
    }
  } catch (_) { /* fall through */ }
  return false; // no confirm API: fail closed for destructive Stop all
}

// ---- pure HTML render helpers ----------------------------------------------

function isDetailOpen(detailsOpen, id) {
  return detailsOpen != null && detailsOpen.has(id);
}

function renderToolbar(view) {
  const badge = view.badge !== '' && view.badge != null
    ? `<span class="toolbar-badge" aria-label="${escapeAttr(`${view.badge} active job${view.badge === '1' ? '' : 's'}`)}">${escapeHtml(String(view.badge))}</span>`
    : '';
  return `<section class="toolbar"><strong class="toolbar-title">Activity</strong>${badge}<span class="toolbar-actions"><button class="secondary" type="button" data-refresh>Refresh</button></span></section>`;
}

const FEEDBACK_KINDS = new Set(['info', 'ok', 'error']);

function renderFeedback(feedback) {
  if (!feedback) return '';
  const kind = FEEDBACK_KINDS.has(feedback.kind) ? feedback.kind : 'info';
  return `<div class="feedback feedback-${kind}" role="status" aria-live="polite">${escapeHtml(feedback.text)}</div>`;
}

function renderErrors(view) {
  const errors = Array.isArray(view.errors) ? view.errors : [];
  const items = errors.slice(-MAX_RENDERED_ERRORS).reverse();
  if (items.length === 0) return '';
  return `<div class="errors" role="status" aria-live="polite">${items.map((e) => `<div class="error">${escapeHtml(e && e.message)}</div>`).join('')}</div>`;
}

function renderDiagnostics(view, detailsOpen) {
  const diagnostics = Array.isArray(view.diagnostics) ? view.diagnostics : [];
  const items = diagnostics.slice(-MAX_RENDERED_DIAGNOSTICS).reverse();
  if (items.length === 0) return '';
  const rows = items.map((d) => {
    const time = d && Number.isFinite(d.at) ? ` <span class="diag-time">${escapeHtml(formatRelative(d.at, view.now))}</span>` : '';
    return `<li><span class="diag-level">${escapeHtml(d && d.level ? String(d.level) : 'info')}</span> <span class="diag-message">${escapeHtml(d && d.message)}</span>${time}</li>`;
  }).join('');
  return `<details class="diagnostics" data-detail-id="diagnostics"${isDetailOpen(detailsOpen, 'diagnostics') ? ' open' : ''}><summary>Diagnostics (${items.length})</summary><ul class="diagnostic-list">${rows}</ul></details>`;
}

function field(label, safeHtml) {
  return `<span class="field"><span class="field-label">${escapeHtml(label)}</span> ${safeHtml}</span>`;
}

function detail(id, summaryText, bodyHtml, detailsOpen) {
  return `<details data-detail-id="${escapeAttr(id)}"${isDetailOpen(detailsOpen, id) ? ' open' : ''}><summary>${escapeHtml(summaryText)}</summary>${bodyHtml}</details>`;
}

function renderPlanChip(plan) {
  const bits = ['PLAN'];
  if (plan.stateLabel) bits.push(escapeHtml(plan.stateLabel));
  if (plan.sinceText) bits.push(`since ${escapeHtml(plan.sinceText)}`);
  if (plan.reason) bits.push(escapeHtml(plan.reason));
  return `<span class="chip tone-${escapeAttr(plan.tone)}">${bits.join(' · ')}</span>`;
}

function renderJob(job, session, view, detailsOpen) {
  const sessionId = String(session.sessionId ?? '');
  const jobId = String(job.id ?? '');
  const presentation = jobStatusPresentation(job, view.disconnected === true);
  const stopDisabled = view.disconnected === true || session.stopPending === true || job.canStop !== true;
  const stopTitle = stopDisabled
    ? stopUnavailableReasonForJob(job, session, view.disconnected === true)
    : `Stop job ${jobId}`;
  const modelText = job.modelName || job.model || job.providerName || '';
  const progressText = formatRelative(view.now - job.progressAge, view.now);
  const fields = [
    field('elapsed', escapeHtml(formatDuration(job.elapsed))),
    field('progress', escapeHtml(progressText || 'no progress')),
  ];
  if (job.queuePosition != null) fields.push(field('queue', `#${escapeHtml(String(job.queuePosition))}`));
  if (job.timedOut === true) fields.push(field('timeout', escapeHtml('timed out')));
  else if (job.timeoutAt != null && Number.isFinite(job.timeoutAt)) fields.push(field('timeout', escapeHtml(formatRelative(job.timeoutAt, view.now))));
  if (modelText) fields.push(field('model', `<code>${escapeHtml(modelText)}</code>`));
  if (job.thinking) fields.push(field('thinking', escapeHtml(job.thinking)));

  const details = [];
  if (Array.isArray(job.progress) && job.progress.length > 0) {
    details.push(detail(`progress-${sessionId}-${jobId}`, `Progress (${job.progress.length})`, `<ol>${job.progress.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ol>`, detailsOpen));
  }
  if (Array.isArray(job.changedFiles) && job.changedFiles.length > 0) {
    details.push(detail(`files-${sessionId}-${jobId}`, `Changed files (${job.changedFiles.length})`, `<ul>${job.changedFiles.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`, detailsOpen));
  }
  if (job.resultSummary) details.push(detail(`result-${sessionId}-${jobId}`, 'Result', `<pre>${escapeHtml(job.resultSummary)}</pre>`, detailsOpen));
  if (job.errorSummary) details.push(detail(`error-${sessionId}-${jobId}`, 'Error summary', `<pre>${escapeHtml(job.errorSummary)}</pre>`, detailsOpen));
  if (job.logPath) details.push(detail(`log-${sessionId}-${jobId}`, 'Log path', `<code class="log-path">${escapeHtml(job.logPath)}</code>`, detailsOpen));

  return `<li class="job-card">
    <div class="job-copy">
      <div class="job-title-line">
        <strong class="job-name">${escapeHtml(job.name)}</strong>
        <span class="chip status-chip tone-${escapeAttr(presentation.tone)}">${escapeHtml(presentation.label)}</span>
      </div>
      <div class="job-fields">${fields.join('')}</div>
      ${details.join('')}
    </div>
    <div class="job-actions">
      <button class="danger" type="button" data-session-id="${escapeAttr(sessionId)}" data-stop-one="${escapeAttr(jobId)}"${stopDisabled ? ' disabled' : ''} title="${escapeAttr(stopTitle)}" aria-label="${escapeAttr(`Stop job ${jobId}`)}">${job.stopping ? 'Stopping…' : 'Stop'}</button>
    </div>
  </li>`;
}

function renderBackgroundTask(task, disconnected) {
  const presentation = jobStatusPresentation(task, disconnected);
  return `<li class="task-plan-row">
    <span class="task-position">${escapeHtml(String((task.position ?? 0) + 1))}</span>
    <code class="task-id">${escapeHtml(task.name || task.id)}</code>
    <span class="chip status-chip tone-${escapeAttr(presentation.tone)}">${escapeHtml(presentation.label)}</span>
  </li>`;
}

function renderBackgroundRun(run, view) {
  const presentation = jobStatusPresentation(run, view.disconnected === true);
  const fields = [
    field('elapsed', escapeHtml(formatDuration(run.elapsed))),
    field('progress', escapeHtml(formatRelative(view.now - run.progressAge, view.now) || 'no output')),
  ];
  if (run.timeoutAt != null && Number.isFinite(run.timeoutAt)) {
    fields.push(field('timeout', escapeHtml(run.timedOut ? 'timed out' : formatRelative(run.timeoutAt, view.now))));
  }
  if (run.exitCode != null) fields.push(field('exit', escapeHtml(String(run.exitCode))));
  if (run.signal) fields.push(field('signal', escapeHtml(run.signal)));
  if (run.terminationReason) fields.push(field('reason', escapeHtml(run.terminationReason)));
  return `<li class="background-run-card">
    <div class="job-title-line">
      <strong class="job-name">${escapeHtml(run.name || run.id)}</strong>
      <span class="chip status-chip tone-${escapeAttr(presentation.tone)}">${escapeHtml(presentation.label)}</span>
    </div>
    <div class="job-fields">${fields.join('')}</div>
    <div class="run-task-link">task <code>${escapeHtml(run.taskId)}</code></div>
  </li>`;
}

function renderBackgroundSection(background, view) {
  if (!background) return '';
  const tasks = Array.isArray(background.tasks) ? background.tasks : [];
  const runs = Array.isArray(background.runs) ? background.runs : [];
  if (tasks.length === 0 && runs.length === 0) return '';
  const runtime = backgroundStatusPresentation(background.runtimeStatus);
  const taskRows = tasks.length === 0
    ? '<p class="muted">No task-plan entries.</p>'
    : `<ol class="task-plan">${tasks.map((task) => renderBackgroundTask(task, view.disconnected === true)).join('')}</ol>`;
  const runRows = runs.length === 0
    ? ''
    : `<h5>Managed runs</h5><ul class="background-runs">${runs.map((run) => renderBackgroundRun(run, view)).join('')}</ul>`;
  return `<section class="background-section">
    <header class="subsection-header"><h4>Main-agent Tasks · revision ${escapeHtml(String(background.revision ?? 0))}</h4><span class="chip tone-${escapeAttr(runtime.tone)}">${escapeHtml(runtime.label)}</span></header>
    ${taskRows}
    ${runRows}
  </section>`;
}

function renderSession(session, view, detailsOpen) {
  const sessionId = String(session.sessionId ?? '');
  const smart = smartStatusPresentation(session.smartStatus);
  const plan = planChipPresentation(session.plan, view.now);
  const stopAllDisabled = view.disconnected === true || session.stopPending === true || !(session.stop && session.stop.available);
  const stopAllTitle = stopAllDisabled
    ? stopUnavailableReasonForSession(session, view.disconnected === true)
    : `Stop all active sub-agent jobs in session ${sessionId}`;
  const jobs = Array.isArray(session.jobs) ? session.jobs : [];
  const backgroundHtml = renderBackgroundSection(session.background, view);
  const header = `<header class="session-header">
    <h3 class="session-title">${escapeHtml(sessionId)}</h3>
    <span class="chip tone-${escapeAttr(smart.tone)}">${escapeHtml(smart.label)}</span>
    ${plan ? renderPlanChip(plan) : ''}
    <span class="active-count">${escapeHtml(String(session.activeCount ?? 0))} active</span>
    <button class="danger" type="button" data-stop-all="${escapeAttr(sessionId)}"${stopAllDisabled ? ' disabled' : ''} title="${escapeAttr(stopAllTitle)}">Stop agents</button>
  </header>`;
  const smartJobsHtml = jobs.length === 0
    ? ''
    : `<section class="smart-jobs-section"><h4>Sub-agents</h4><ul class="jobs">${jobs.map((job) => renderJob(job, session, view, detailsOpen)).join('')}</ul></section>`;
  const body = backgroundHtml || smartJobsHtml
    ? `${backgroundHtml}${smartJobsHtml}`
    : '<p class="muted">No jobs or task plan recorded for this session.</p>';
  return `<section class="session${session.selected ? ' selected' : ''}" data-session-id="${escapeAttr(sessionId)}"${session.selected ? ' aria-current="true"' : ''}>${header}${body}</section>`;
}

/**
 * renderActivityPanelHtml(view, options) — pure HTML string for the panel
 * shadow root (no DOM access). options: { detailsOpen: Set<string> of fold
 * ids to keep open, feedback: { kind, text } }. Renders the view in view-model
 * order (active sessions first), never raw store internals.
 */
export function renderActivityPanelHtml(view, options = {}) {
  const detailsOpen = options.detailsOpen instanceof Set ? options.detailsOpen : null;
  const feedback = options.feedback && typeof options.feedback === 'object' ? options.feedback : null;
  if (view == null) {
    return `${activityStyles()}<section class="empty">Select a workspace.</section>`;
  }
  const sessions = Array.isArray(view.sessions) ? view.sessions : [];
  const parts = [];
  parts.push(renderToolbar(view));
  if (view.disconnected === true) {
    parts.push('<div class="banner disconnected" role="status">Disconnected from activity records — showing the last known state.</div>');
  }
  const feedbackHtml = renderFeedback(feedback);
  if (feedbackHtml) parts.push(feedbackHtml);
  const errorsHtml = renderErrors(view);
  if (errorsHtml) parts.push(errorsHtml);
  parts.push('<section class="activity-viewer">');
  if (sessions.length === 0) {
    parts.push('<p class="muted">No activity records in this workspace yet.</p>');
  } else {
    for (const session of sessions) parts.push(renderSession(session, view, detailsOpen));
  }
  const diagnosticsHtml = renderDiagnostics(view, detailsOpen);
  if (diagnosticsHtml) parts.push(diagnosticsHtml);
  parts.push('</section>');
  return `${activityStyles()}${parts.join('')}`;
}

// ---- styles (touch/mobile/accessibility requirements live here) ------------

export function activityStyles() {
  return `
  <style>
    :host { display: contents; }
    *, *::before, *::after { box-sizing: border-box; }
    .toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--pi-border-muted); }
    .toolbar-title { flex: 1 1 auto; min-width: 0; font-size: 14px; }
    .toolbar-actions { display: inline-flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .toolbar-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 24px; min-height: 24px; padding: 2px 9px; border-radius: 999px; background: var(--pi-accent); color: var(--pi-bg); font-size: 12px; font-weight: 600; }
    button { min-height: 44px; min-width: 44px; padding: 8px 12px; border: 1px solid var(--pi-accent-border); border-radius: 8px; background: var(--pi-accent); color: var(--pi-bg); cursor: pointer; font: inherit; }
    button.secondary { border-color: var(--pi-border); background: var(--pi-surface); color: var(--pi-text); }
    button.danger { border-color: var(--pi-danger); background: var(--pi-danger); color: #fff; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    button:focus-visible, summary:focus-visible { outline: 2px solid var(--pi-accent); outline-offset: 2px; }
    .banner { margin: 12px 12px 0; border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px 12px; }
    .banner.disconnected { border-color: var(--pi-danger); color: var(--pi-danger); }
    .feedback { margin: 10px 12px 0; border: 1px solid var(--pi-border); border-radius: 8px; padding: 10px 12px; }
    .feedback-ok { border-color: var(--pi-success); color: var(--pi-success); }
    .feedback-error { border-color: var(--pi-danger); color: var(--pi-danger); }
    .errors { margin: 10px 12px 0; display: grid; gap: 4px; }
    .error { border: 1px solid var(--pi-danger); color: var(--pi-danger); border-radius: 6px; padding: 8px 10px; overflow-wrap: anywhere; }
    .activity-viewer { box-sizing: border-box; min-height: 0; overflow: auto; padding: 12px; display: grid; align-content: start; gap: 12px; }
    .session { display: grid; gap: 10px; border: 1px solid var(--pi-border); border-radius: 10px; background: var(--pi-surface); padding: 12px; }
    .session.selected { border-color: var(--pi-accent); box-shadow: inset 2px 0 0 var(--pi-accent); }
    .session-header { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
    .session-title { margin: 0; min-width: 0; font-size: 13px; overflow-wrap: anywhere; }
    .active-count { margin-left: auto; color: var(--pi-text-secondary); font-size: 12px; }
    .chip { display: inline-flex; align-items: center; min-height: 22px; padding: 2px 9px; border: 1px solid currentColor; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .tone-live { color: var(--pi-success); }
    .tone-ok { color: var(--pi-success); }
    .tone-info { color: var(--pi-accent); }
    .tone-warn { color: var(--pi-warning, #c98a2e); }
    .tone-danger { color: var(--pi-danger); }
    .tone-muted { color: var(--pi-muted); }
    .tone-disconnected { color: var(--pi-danger); border-style: dashed; }
    .background-section, .smart-jobs-section { display: grid; gap: 8px; border-top: 1px solid var(--pi-border-muted); padding-top: 10px; }
    .background-section:first-of-type { border-top: 0; padding-top: 0; }
    .background-section h4, .smart-jobs-section h4, .background-section h5 { margin: 0; font-size: 12px; color: var(--pi-text-secondary); }
    .subsection-header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
    .task-plan { margin: 0; padding: 0; display: grid; gap: 6px; list-style: none; }
    .task-plan-row { display: grid; grid-template-columns: 24px minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 1px solid var(--pi-border-muted); border-radius: 7px; padding: 7px 9px; }
    .task-position { color: var(--pi-muted); font-variant-numeric: tabular-nums; }
    .task-id { display: inline; width: fit-content; white-space: normal; overflow-wrap: anywhere; }
    .background-runs { margin: 0; padding: 0; display: grid; gap: 8px; list-style: none; }
    .background-run-card { display: grid; gap: 6px; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-bg); padding: 10px; }
    .run-task-link { color: var(--pi-muted); font-size: 12px; }
    .run-task-link code { display: inline; padding: 2px 5px; white-space: normal; }
    .jobs { margin: 0; padding: 0; display: grid; gap: 10px; list-style: none; }
    .job-card { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px 12px; align-items: start; border: 1px solid var(--pi-border-muted); border-radius: 8px; background: var(--pi-bg); padding: 10px; }
    .job-copy { display: grid; min-width: 0; gap: 6px; }
    .job-title-line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
    .job-name { min-width: 0; overflow-wrap: anywhere; }
    .job-fields { display: flex; flex-wrap: wrap; gap: 4px 12px; color: var(--pi-text-secondary); font-size: 12px; }
    .field { display: inline-flex; align-items: center; gap: 4px; }
    .field-label { color: var(--pi-muted); }
    .job-actions { display: flex; justify-content: flex-end; }
    code, pre { border: 1px solid var(--pi-border-muted); border-radius: 6px; background: var(--pi-bg); color: var(--pi-text-secondary); font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    code { display: block; overflow: auto; padding: 4px 6px; white-space: nowrap; max-width: 100%; }
    pre { margin: 6px 0 0; overflow: auto; padding: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
    details { margin-top: 6px; }
    details summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; color: var(--pi-text-secondary); font-size: 12px; }
    details ol, details ul { margin: 4px 0 0; padding-left: 20px; }
    details li { overflow-wrap: anywhere; }
    .diagnostics { border-top: 1px solid var(--pi-border-muted); padding-top: 6px; }
    .diag-level { font-weight: 600; }
    .muted { color: var(--pi-muted); }
    .empty { padding: 16px; color: var(--pi-muted); }
    @media (max-width: 760px) {
      .job-card { grid-template-columns: 1fr; }
      .task-plan-row { grid-template-columns: 24px minmax(0, 1fr); }
      .task-plan-row .status-chip { grid-column: 2; justify-self: start; }
      .job-actions { justify-content: flex-start; }
      .session-header { gap: 6px 8px; }
      .active-count { margin-left: 0; flex-basis: 100%; }
    }
    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
    }
  </style>
  `;
}

// ---- custom element --------------------------------------------------------
// Lazy base: in non-DOM environments (tests, SSR) there is no HTMLElement, so
// the element class falls back to a bare class and is never registered
// (defineActivityPanelElement returns false there).
const HTMLElementBase = typeof HTMLElement !== 'undefined' ? HTMLElement : class {};

class PiWebActivityPanel extends HTMLElementBase {
  #contextValue;
  #subscription = null;
  #subscribedKey = undefined;
  #renderedKey = undefined;
  #feedback = null;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
  }

  get context() {
    return this.#contextValue;
  }

  set context(value) {
    const previousKey = this.#contextValue === undefined ? undefined : controllerCacheKeyForContext(this.#contextValue);
    const nextKey = value === undefined ? undefined : controllerCacheKeyForContext(value);
    this.#contextValue = value;
    if (previousKey !== undefined && previousKey === nextKey) {
      // Same workspace: keep the subscription and re-render with the new
      // context (selectedSession may have changed) while preserving the
      // mobile scroll position and open detail folds.
      this.#ensureSubscription();
      this.render();
      return;
    }
    this.#unsubscribeController();
    this.#feedback = null;
    this.#ensureSubscription();
    this.render();
  }

  connectedCallback() {
    ensureGlobalListeners();
    this.#ensureSubscription();
    this.render();
  }

  disconnectedCallback() {
    this.#unsubscribeController();
  }

  #ensureSubscription() {
    const value = this.#contextValue;
    if (value === undefined) return;
    const key = controllerCacheKeyForContext(value);
    if (this.#subscription && this.#subscribedKey === key) return;
    this.#unsubscribeController();
    try {
      const controller = getControllerForContext(value);
      this.#subscribedKey = key;
      this.#subscription = controller.subscribe(() => { this.render(); });
    } catch (err) {
      this.#feedback = { kind: 'error', text: `Activity unavailable: ${err && err.message ? err.message : String(err)}` };
    }
  }

  #unsubscribeController() {
    if (this.#subscription) {
      try { this.#subscription(); } catch (_) { /* best-effort */ }
      this.#subscription = null;
    }
    this.#subscribedKey = undefined;
  }

  render() {
    if (this.#contextValue === undefined) {
      this.#renderedKey = undefined;
      this.root.innerHTML = renderActivityPanelHtml(null, {});
      return;
    }
    try {
      const key = controllerCacheKeyForContext(this.#contextValue);
      const sameWorkspace = key === this.#renderedKey;
      const viewer = this.root.querySelector('.activity-viewer');
      const scrollTop = sameWorkspace && viewer ? viewer.scrollTop : 0;
      const detailsOpen = this.#collectOpenDetailIds();
      const controller = getControllerForContext(this.#contextValue);
      const view = controller.getView(selectedSessionOf(this.#contextValue));
      this.root.innerHTML = renderActivityPanelHtml(view, { detailsOpen, feedback: this.#feedback });
      const nextViewer = this.root.querySelector('.activity-viewer');
      if (nextViewer && scrollTop > 0) nextViewer.scrollTop = scrollTop;
      this.#renderedKey = key;
      this.#bindEvents();
    } catch (err) {
      this.root.innerHTML = `${activityStyles()}<section class="empty">Activity panel error: ${escapeHtml(String(err && err.message ? err.message : err))}</section>`;
    }
  }

  #collectOpenDetailIds() {
    const ids = new Set();
    for (const el of this.root.querySelectorAll('details[open]')) {
      const id = el.getAttribute('data-detail-id');
      if (id) ids.add(id);
    }
    return ids;
  }

  #bindEvents() {
    const refreshButton = this.root.querySelector('button[data-refresh]');
    if (refreshButton) refreshButton.addEventListener('click', () => { void this.refresh(); });
    for (const button of this.root.querySelectorAll('button[data-stop-all]')) {
      button.addEventListener('click', () => { void this.stopAll(button.getAttribute('data-stop-all')); });
    }
    for (const button of this.root.querySelectorAll('button[data-stop-one]')) {
      button.addEventListener('click', () => {
        void this.stopOne(button.getAttribute('data-session-id'), button.getAttribute('data-stop-one'));
      });
    }
  }

  #isCurrentContext(context) {
    return this.#contextValue !== undefined
      && controllerCacheKeyForContext(this.#contextValue) === controllerCacheKeyForContext(context);
  }

  #setFeedback(kind, text) {
    this.#feedback = { kind, text: String(text) };
    this.render();
  }

  async refresh() {
    const context = this.#contextValue;
    if (context === undefined) return;
    this.#setFeedback('info', 'Refreshing activity…');
    try {
      const controller = getControllerForContext(context);
      await controller.refreshNow();
    } catch (err) {
      if (this.#isCurrentContext(context)) {
        this.#setFeedback('error', `Refresh failed: ${err && err.message ? err.message : String(err)}`);
      }
      return;
    }
    if (!this.#isCurrentContext(context)) return;
    this.#setFeedback('ok', 'Activity refreshed.');
  }

  async stopAll(sessionId) {
    const context = this.#contextValue;
    if (context === undefined || sessionId == null) return;
    const id = String(sessionId);
    if (!guardedConfirm(confirmStopAllMessage(id))) {
      this.#setFeedback('info', `Stop all for ${id} cancelled.`);
      return;
    }
    this.#setFeedback('info', `Stop all for ${id}: request sent — pending runtime confirmation.`);
    const controller = getControllerForContext(context);
    let result;
    try {
      result = await controller.stopAll(id);
    } catch (err) {
      if (this.#isCurrentContext(context)) {
        this.#setFeedback('error', `Stop all failed: ${err && err.message ? err.message : String(err)}`);
      }
      return;
    }
    if (!this.#isCurrentContext(context)) return;
    this.#setFeedback(result.ok ? 'ok' : 'error', result.ok
      ? `Stop all for ${id}: request sent — pending runtime confirmation.`
      : String(result.reason || 'Stop all failed.'));
  }

  async stopOne(sessionId, jobId) {
    const context = this.#contextValue;
    if (context === undefined || sessionId == null || jobId == null) return;
    const sid = String(sessionId);
    const jid = String(jobId);
    this.#setFeedback('info', `Stop ${jid}: request sent — pending runtime confirmation.`);
    const controller = getControllerForContext(context);
    let result;
    try {
      result = await controller.stopOne(sid, jid);
    } catch (err) {
      if (this.#isCurrentContext(context)) {
        this.#setFeedback('error', `Stop failed: ${err && err.message ? err.message : String(err)}`);
      }
      return;
    }
    if (!this.#isCurrentContext(context)) return;
    this.#setFeedback(result.ok ? 'ok' : 'error', result.ok
      ? `Stop ${jid}: request sent — pending runtime confirmation.`
      : String(result.reason || 'Stop failed.'));
  }
}

export function defineActivityPanelElement() {
  if (typeof customElements === 'undefined') return false;
  if (customElements.get(activityPanelTagName)) return true;
  customElements.define(activityPanelTagName, PiWebActivityPanel);
  return true;
}
