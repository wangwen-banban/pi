import { randomBytes, randomUUID } from "node:crypto";
import { registerContextSnapshot } from "../shared/context-snapshot.ts";
import * as path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	WebActivityRegistry,
} from "../web-activity/registry.ts";
import {
	createActivityWidgetOwner,
	releaseActivityWidgetSection,
	setActivityWidgetSection,
} from "../shared/activity-widget-stack.ts";
import { createCompletionQueue } from "./completion-queue.ts";
import {
	validateBackgroundHealthPolicy,
	type BackgroundHealthPolicy,
} from "./health-policy.ts";
import {
	COMPLETED_TASK_HOLD_MS,
	TASK_PLAN_MARKER_TYPE,
	TASK_STATUSES,
	attachRunToTask,
	blockTaskRecovery,
	clearCompletedTaskHistory,
	durableTaskPlanMarker,
	emptyTaskPlan,
	finishTaskRun,
	nextPendingTask,
	reconcileTaskPlan,
	reconstructTaskPlan,
	taskPlanText,
	visibleTaskPlanItems,
	type TaskPlan,
	type TaskPlanInput,
	type TaskStatus,
} from "./plan-state.ts";
import {
	BACKGROUND_RUN_RECORD_VERSION,
	startManagedBackgroundRun,
	type BackgroundRunController,
	type BackgroundRunSnapshot,
} from "./runner.ts";
import {
	SAFE_SESSION_ID,
	readTerminalRunManifest,
	snapshotFromTerminalManifest,
	terminalManifestFromSnapshot,
	type TerminalManifestFailureCode,
	type TerminalRunManifest,
} from "./run-persistence.ts";
import {
	BACKGROUND_WAKE_MARKER_TYPE,
	acknowledgedWakeMarker,
	deliveryWakeMarker,
	pendingWakeMarker,
	reconstructWakeOutbox,
	type DeliveryBackgroundWakeMarker,
	type WakeDeliveryItem,
} from "./wake-state.ts";
import {
	buildBackgroundRuntimeRecord,
	buildBackgroundTasksRecord,
	writeBackgroundWebRecord,
} from "./web-record.ts";

const DEFAULT_RUNS_DIR = path.join(getAgentDir(), "background-task-runs");
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_HEALTH_WINDOW_MS = 1_000;
const MAX_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINATE_GRACE_MS = 5_000;
const KILL_CONFIRM_MS = 5_000;
const MAX_TAIL_BYTES = 32 * 1024;
const WAKE_WATCHDOG_MS = 30_000;
const WAKE_RETRY_BASE_MS = 500;
const WAKE_RETRY_MAX_MS = 30_000;
const COMPLETION_OUTPUT_BYTES = 12 * 1024;
const MAX_COMMAND_CHARS = 32 * 1024;
const MAX_RECENT_RUNS = 50;
const WEB_HEARTBEAT_MS = 5_000;
const WEB_PROGRESS_FLUSH_MS = 2_000;
const COMPLETED_DISMISS_MS = 15_000;

const TaskStatusSchema = StringEnum(TASK_STATUSES);
const UpdateTaskPlanParams = Type.Object({
	baseRevision: Type.Number({ description: "Revision currently shown to the model. Stale revisions are rejected." }),
	explanation: Type.Optional(Type.String({ description: "Why this prompt changes the task plan." })),
	tasks: Type.Array(Type.Object({
		id: Type.String({ description: "Stable lowercase task id (letters, numbers, dot, underscore, hyphen)." }),
		title: Type.String({ description: "Concise user-visible task title." }),
		status: TaskStatusSchema,
	}), { maxItems: 50 }),
});

const HealthPolicyParams = Type.Object({
	startupGraceMs: Type.Optional(Type.Integer({
		minimum: MIN_HEALTH_WINDOW_MS,
		maximum: MAX_HEALTH_WINDOW_MS,
		description: "Time allowed for the first valid fd-3 health record. Defaults to heartbeatTimeoutMs.",
	})),
	heartbeatTimeoutMs: Type.Integer({
		minimum: MIN_HEALTH_WINDOW_MS,
		maximum: MAX_HEALTH_WINDOW_MS,
		description: "Fail if no valid machine-readable health record arrives for this long.",
	}),
	unavailableTimeoutMs: Type.Integer({
		minimum: MIN_HEALTH_WINDOW_MS,
		maximum: MAX_HEALTH_WINDOW_MS,
		description: "Fail if records continuously report health=unavailable for this long.",
	}),
	staleProgressTimeoutMs: Type.Optional(Type.Integer({
		minimum: MIN_HEALTH_WINDOW_MS,
		maximum: MAX_HEALTH_WINDOW_MS,
		description: "Fail if the opaque progress token does not change for this long while health is healthy.",
	})),
}, { additionalProperties: false });

const RunBackgroundTaskParams = Type.Object({
	taskId: Type.String({ description: "Task-plan id to mark in_progress and bind to this run." }),
	name: Type.Optional(Type.String({ description: "Short run name shown in activity; defaults to taskId." })),
	command: Type.String({ description: "Shell command to run under the managed background monitor." }),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session cwd unless absolute." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wall-clock timeout in milliseconds. Default 6 hours; range 1 second–7 days." })),
	healthPolicy: Type.Optional(HealthPolicyParams),
});

const StopBackgroundTaskParams = Type.Object({
	id: Type.String({ description: "Exact run id or task id to stop." }),
});

interface UpdatePlanDetails {
	plan: TaskPlan;
}

interface RunDetails {
	run: {
		id: string;
		taskId: string;
		name: string;
		status: BackgroundRunSnapshot["status"];
		createdAt: number;
		startedAt: number;
		timeoutAt: number;
		healthStatus?: BackgroundRunSnapshot["healthStatus"];
		healthDeadlineAt?: number;
	};
	planRevision: number;
}

interface CompletionNotice {
	id: string;
	run: BackgroundRunSnapshot;
}

interface CompletionRunDetails {
	id: string;
	taskId: string;
	name: string;
	status: BackgroundRunSnapshot["status"];
	startedAt: number;
	finishedAt?: number;
	terminationReason?: BackgroundRunSnapshot["terminationReason"];
}

interface CompletionBatchDetails {
	runs: CompletionRunDetails[];
	planRevision: number;
	nextTaskId?: string;
	wake: {
		sessionId: string;
		deliveryId: string;
		attempt: number;
		items: WakeDeliveryItem[];
	};
}

interface PendingWakeState {
	run: BackgroundRunSnapshot;
	terminal: TerminalRunManifest;
	sequence: number;
	pendingPersisted: boolean;
	planPersisted: boolean;
}

interface ActiveWakeDelivery {
	marker: DeliveryBackgroundWakeMarker;
	notices: CompletionNotice[];
	sentAgentGeneration: number;
	boundAgentGeneration?: number;
	messageStarted: boolean;
	successfulStop: boolean;
	failedResponse: boolean;
	watchdog: ReturnType<typeof setTimeout>;
}

function safeRunName(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[.-]+|[.-]+$/g, "")
		.slice(0, 63) || "background-task";
}

function clampTimeout(value: number | undefined): number {
	if (value === undefined) return DEFAULT_TIMEOUT_MS;
	if (!Number.isFinite(value)) throw new Error("timeoutMs must be finite");
	return Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, Math.floor(value)));
}

function healthWindow(value: number, field: string): number {
	if (!Number.isSafeInteger(value) || value < MIN_HEALTH_WINDOW_MS || value > MAX_HEALTH_WINDOW_MS) {
		throw new Error(`${field} must be an integer from ${MIN_HEALTH_WINDOW_MS} to ${MAX_HEALTH_WINDOW_MS} milliseconds`);
	}
	return value;
}

function normalizeHealthPolicy(value: {
	startupGraceMs?: number;
	heartbeatTimeoutMs: number;
	unavailableTimeoutMs: number;
	staleProgressTimeoutMs?: number;
} | undefined): BackgroundHealthPolicy | undefined {
	if (value === undefined) return undefined;
	const heartbeatTimeoutMs = healthWindow(value.heartbeatTimeoutMs, "healthPolicy.heartbeatTimeoutMs");
	return validateBackgroundHealthPolicy({
		startupGraceMs: healthWindow(value.startupGraceMs ?? heartbeatTimeoutMs, "healthPolicy.startupGraceMs"),
		heartbeatTimeoutMs,
		unavailableTimeoutMs: healthWindow(value.unavailableTimeoutMs, "healthPolicy.unavailableTimeoutMs"),
		...(value.staleProgressTimeoutMs === undefined
			? {}
			: { staleProgressTimeoutMs: healthWindow(value.staleProgressTimeoutMs, "healthPolicy.staleProgressTimeoutMs") }),
	});
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(-maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes && result.length > 0) result = result.slice(1);
	return `[earlier output omitted]\n${result}`;
}

function resultSummary(run: BackgroundRunSnapshot): string {
	if (run.status === "completed") return `exit ${run.exitCode ?? 0}`;
	if (run.status === "stopped") return run.stopReason === "shutdown" ? "interrupted by session shutdown" : "stopped by user";
	return run.error || (run.signal ? `signal ${run.signal}` : `exit ${run.exitCode ?? "unknown"}`);
}

function runDetails(run: BackgroundRunSnapshot, planRevision: number): RunDetails {
	return {
		run: {
			id: run.id,
			taskId: run.taskId,
			name: run.taskId,
			status: run.status,
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			timeoutAt: run.timeoutAt,
			...(run.healthStatus === undefined ? {} : { healthStatus: run.healthStatus }),
			...(run.healthDeadlineAt === undefined ? {} : { healthDeadlineAt: run.healthDeadlineAt }),
		},
		planRevision,
	};
}

function runDuration(run: BackgroundRunSnapshot | CompletionRunDetails): string {
	const end = run.finishedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${seconds % 60}s`;
}

function completionOutput(run: BackgroundRunSnapshot): string {
	const safeConsoleText = (value: string) => value
		.replace(/\r/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
	const sections = [];
	if (run.stdoutTail.trim()) sections.push(`stdout tail:\n${safeConsoleText(run.stdoutTail).trim()}`);
	if (run.stderrTail.trim()) sections.push(`stderr tail:\n${safeConsoleText(run.stderrTail).trim()}`);
	return truncateUtf8(sections.join("\n\n") || "(no console output)", COMPLETION_OUTPUT_BYTES);
}

function runIsActive(run: BackgroundRunSnapshot): boolean {
	return run.status === "running";
}

function runShouldWake(run: BackgroundRunSnapshot): boolean {
	return run.terminationReason !== "session_shutdown" && run.stopReason !== "shutdown";
}

export interface WakeRetryScheduler {
	setTimeout(callback: () => void, delayMs: number): unknown;
	clearTimeout(handle: unknown): void;
}

const nativeWakeRetryScheduler: WakeRetryScheduler = {
	setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function unrefTimer(handle: unknown): void {
	if (handle && typeof handle === "object" && "unref" in handle) {
		(handle as { unref?: () => void }).unref?.();
	}
}

export interface BackgroundTasksExtensionOptions {
	runsDir?: string;
	startRun?: typeof startManagedBackgroundRun;
	completionDebounceMs?: number;
	completedTaskHoldMs?: number;
	wakeWatchdogMs?: number;
	wakeRetryBaseMs?: number;
	wakeRetryMaxMs?: number;
	wakeRetryScheduler?: WakeRetryScheduler;
	killConfirmMs?: number;
}

type ResolvedBackgroundTasksExtensionOptions = Required<BackgroundTasksExtensionOptions>;

export function createBackgroundTasksExtension(options: BackgroundTasksExtensionOptions = {}) {
	const resolved: ResolvedBackgroundTasksExtensionOptions = {
		runsDir: options.runsDir ?? DEFAULT_RUNS_DIR,
		startRun: options.startRun ?? startManagedBackgroundRun,
		completionDebounceMs: options.completionDebounceMs ?? 100,
		completedTaskHoldMs: Number.isFinite(options.completedTaskHoldMs)
			? Math.max(0, Math.floor(options.completedTaskHoldMs!))
			: COMPLETED_TASK_HOLD_MS,
		wakeWatchdogMs: Number.isFinite(options.wakeWatchdogMs)
			? Math.max(1, Math.floor(options.wakeWatchdogMs!))
			: WAKE_WATCHDOG_MS,
		wakeRetryBaseMs: Number.isFinite(options.wakeRetryBaseMs)
			? Math.max(1, Math.floor(options.wakeRetryBaseMs!))
			: WAKE_RETRY_BASE_MS,
		wakeRetryMaxMs: Number.isFinite(options.wakeRetryMaxMs)
			? Math.max(1, Math.floor(options.wakeRetryMaxMs!))
			: WAKE_RETRY_MAX_MS,
		wakeRetryScheduler: options.wakeRetryScheduler ?? nativeWakeRetryScheduler,
		killConfirmMs: Number.isFinite(options.killConfirmMs)
			? Math.max(1, Math.floor(options.killConfirmMs!))
			: KILL_CONFIRM_MS,
	};
	return function backgroundTasks(pi: ExtensionAPI) {
		registerBackgroundTasks(pi, resolved);
	};
}

function registerBackgroundTasks(pi: ExtensionAPI, extensionOptions: ResolvedBackgroundTasksExtensionOptions) {
	const activityWidgetOwner = createActivityWidgetOwner("tasks");
	let plan = emptyTaskPlan();
	let latestCtx: ExtensionContext | undefined;
	let shuttingDown = false;
	let branchChanging = false;
	let boundSessionId = "";
	let sessionEpoch = 0;
	let agentGeneration = 0;
	let nextWakeSequence = 1;
	let nextWakeAttempt = 1;
	let wakeRetryRound = 0;
	let wakeRetryTimer: { handle: unknown } | undefined;
	let lastWakeDiagnosticAt = 0;
	let activeWakeDelivery: ActiveWakeDelivery | undefined;
	const controllers = new Map<string, BackgroundRunController>();
	const runs = new Map<string, BackgroundRunSnapshot>();
	const lastProgressEventAt = new Map<string, number>();
	const pendingWakes = new Map<string, PendingWakeState>();
	const acknowledgedWakeTerminals = new Map<string, TerminalRunManifest>();
	const knownWakeRunIds = new Set<string>();

	let webRegistry: WebActivityRegistry | undefined;
	let webRuntimeId = "";
	let webGeneration = 0;
	let webStartedAt = 0;
	let webEpoch = 0;
	let webHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let lastWebProgressFlushAt = 0;
	let webWriteChain: Promise<boolean> = Promise.resolve(true);
	let webDirty = false;
	let uiExpiryTimer: ReturnType<typeof setTimeout> | undefined;

	const currentSessionId = () => boundSessionId;
	const activeRuns = () => [...runs.values()].filter(runIsActive);

	const pruneRuns = () => {
		const terminal = [...runs.values()]
			.filter((run) => !runIsActive(run))
			.sort((a, b) => (b.finishedAt ?? b.createdAt) - (a.finishedAt ?? a.createdAt));
		for (const run of terminal.slice(MAX_RECENT_RUNS)) runs.delete(run.id);
	};

	const clearUiExpiryTimer = () => {
		if (uiExpiryTimer) clearTimeout(uiExpiryTimer);
		uiExpiryTimer = undefined;
	};

	const updateUi = () => {
		clearUiExpiryTimer();
		const ctx = latestCtx;
		if (!ctx?.hasUI || shuttingDown) return;
		const now = Date.now();
		const compactTasks = visibleTaskPlanItems(plan, now, extensionOptions.completedTaskHoldMs);
		if (compactTasks.length === 0) {
			setActivityWidgetSection(ctx.ui, activityWidgetOwner);
			ctx.ui.setStatus("background-tasks", undefined);
			return;
		}
		const icons: Record<TaskStatus, string> = {
			pending: "○",
			in_progress: "▶",
			completed: "✓",
			failed: "✗",
			blocked: "■",
			cancelled: "−",
		};
		const visible = compactTasks.slice(0, 12);
		const lines = [`Tasks · revision ${plan.revision}`];
		for (const task of visible) {
			const title = task.title.length > 88 ? `${task.title.slice(0, 88)}…` : task.title;
			lines.push(`${icons[task.status]} ${task.id} · ${title}`);
		}
		if (compactTasks.length > visible.length) lines.push(`… ${compactTasks.length - visible.length} more · /tasks`);
		setActivityWidgetSection(ctx.ui, activityWidgetOwner, lines);
		const active = activeRuns().length;
		const pending = plan.tasks.filter((task) => task.status === "pending").length;
		ctx.ui.setStatus(
			"background-tasks",
			active > 0 || pending > 0
				? ctx.ui.theme.fg("accent", `tasks:${active} running${pending ? `/${pending} pending` : ""}`)
				: undefined,
		);
		const expiries = plan.tasks
			.filter((task) => task.status === "completed")
			.map((task) => task.updatedAt + extensionOptions.completedTaskHoldMs)
			.filter((expiresAt) => expiresAt > now);
		if (expiries.length > 0) {
			uiExpiryTimer = setTimeout(() => {
				uiExpiryTimer = undefined;
				updateUi();
			}, Math.max(1, Math.min(...expiries) - now));
			uiExpiryTimer.unref?.();
		}
	};

	const webIdentity = () => ({
		sessionId: currentSessionId(),
		runtimeId: webRuntimeId,
		generation: webGeneration,
	});

	const enqueueWebWrite = (
		registry: WebActivityRegistry,
		name: "runtime" | "background-tasks",
		record: Record<string, unknown>,
	): Promise<boolean> => {
		const write = webWriteChain.then(() => writeBackgroundWebRecord(
			registry.root,
			registry.worktreeRoot,
			name,
			record,
		));
		webWriteChain = write.catch(() => false);
		return write;
	};

	const flushWebTasks = (): Promise<boolean> | undefined => {
		webDirty = false;
		const registry = webRegistry;
		if (!registry || !latestCtx) return undefined;
		return enqueueWebWrite(registry, "background-tasks", buildBackgroundTasksRecord(plan, [...runs.values()], webIdentity()));
	};

	const flushWebRuntime = (state: "active" | "shutdown" = "active"): Promise<boolean> | undefined => {
		const registry = webRegistry;
		if (!registry || !latestCtx) return undefined;
		return enqueueWebWrite(registry, "runtime", buildBackgroundRuntimeRecord(
			webIdentity(),
			state,
			{ startedAt: webStartedAt, total: runs.size, active: activeRuns().length },
		));
	};

	const stopWebHeartbeat = () => {
		if (webHeartbeatTimer) clearInterval(webHeartbeatTimer);
		webHeartbeatTimer = undefined;
	};

	const startWebActivity = async (ctx: ExtensionContext) => {
		const epoch = ++webEpoch;
		webGeneration += 1;
		webRuntimeId = `bg-${randomUUID()}`;
		webStartedAt = Date.now();
		const registry = await WebActivityRegistry.create({
			cwd: ctx.cwd,
			identity: {
				...webIdentity(),
				controlToken: randomBytes(32).toString("hex"),
			},
			env: process.env,
			notify: (message, kind) => {
				try { ctx.ui.notify(message, kind); } catch { /* registry remains authoritative */ }
			},
		});
		if (shuttingDown || epoch !== webEpoch) return;
		webRegistry = registry.enabled ? registry : undefined;
		if (!webRegistry) return;
		stopWebHeartbeat();
		webHeartbeatTimer = setInterval(() => {
			flushWebRuntime("active");
			if (webDirty) flushWebTasks();
		}, WEB_HEARTBEAT_MS);
		webHeartbeatTimer.unref?.();
		flushWebRuntime("active");
		flushWebTasks();
	};

	const notifyWakeDiagnostic = (message: string) => {
		const now = Date.now();
		if (now - lastWakeDiagnosticAt < 5_000) return;
		lastWakeDiagnosticAt = now;
		try { latestCtx?.ui.notify(message.slice(0, 240), "error"); } catch { /* bounded observation */ }
	};

	const persistPlan = (): boolean => {
		let persisted = false;
		try {
			if (!SAFE_SESSION_ID.test(boundSessionId)) throw new Error("invalid session binding");
			pi.appendEntry(TASK_PLAN_MARKER_TYPE, durableTaskPlanMarker(plan, boundSessionId));
			persisted = true;
		} catch {
			notifyWakeDiagnostic("Background task state could not be securely persisted; delivery remains blocked and will retry.");
		}
		updateUi();
		flushWebTasks();
		return persisted;
	};

	const emitLifecycle = (event: "started" | "progress" | "completed" | "failed" | "stopped", run: BackgroundRunSnapshot) => {
		try {
			pi.events.emit(`background-task:${event}`, {
				event,
				timestamp: Date.now(),
				revision: plan.revision,
				run: { ...run },
			});
		} catch {
			// Hooks are observational.
		}
	};

	type WakeMarker = ReturnType<typeof pendingWakeMarker>
		| ReturnType<typeof deliveryWakeMarker>
		| ReturnType<typeof acknowledgedWakeMarker>;
	const appendWakeMarker = (marker: WakeMarker): boolean => {
		if (shuttingDown || marker.sessionId !== boundSessionId) return false;
		try {
			pi.appendEntry(BACKGROUND_WAKE_MARKER_TYPE, marker);
			return true;
		} catch {
			notifyWakeDiagnostic("Background completion state could not be securely persisted; no wake was sent and retry remains pending.");
			return false;
		}
	};

	const clearWakeRetryTimer = () => {
		if (wakeRetryTimer !== undefined) extensionOptions.wakeRetryScheduler.clearTimeout(wakeRetryTimer.handle);
		wakeRetryTimer = undefined;
	};

	const recordPendingWake = (
		run: BackgroundRunSnapshot,
		options: { terminal?: TerminalRunManifest; restored?: boolean; sequence?: number; planPersisted?: boolean; replace?: boolean } = {},
	): PendingWakeState | undefined => {
		if (run.status === "running" || shuttingDown || !SAFE_SESSION_ID.test(boundSessionId)) return undefined;
		if (pendingWakes.has(run.id) && !options.replace) return pendingWakes.get(run.id);
		let terminal: TerminalRunManifest;
		try { terminal = options.terminal ?? terminalManifestFromSnapshot(run, boundSessionId); } catch { return undefined; }
		const state: PendingWakeState = {
			run: { ...run },
			terminal,
			sequence: options.sequence ?? nextWakeSequence++,
			pendingPersisted: Boolean(options.restored),
			planPersisted: options.planPersisted ?? Boolean(options.restored),
		};
		knownWakeRunIds.add(run.id);
		pendingWakes.set(run.id, state);
		return state;
	};

	let completionQueue: ReturnType<typeof createCompletionQueue<CompletionNotice>>;

	const scheduleWakeRetry = () => {
		if (shuttingDown || wakeRetryTimer !== undefined || pendingWakes.size === 0) return;
		completionQueue?.setParentActive(true);
		const exponent = wakeRetryRound++;
		const delay = Math.min(extensionOptions.wakeRetryMaxMs, extensionOptions.wakeRetryBaseMs * (2 ** exponent));
		const epoch = sessionEpoch;
		const scheduled = { handle: undefined as unknown };
		wakeRetryTimer = scheduled;
		scheduled.handle = extensionOptions.wakeRetryScheduler.setTimeout(() => {
			if (wakeRetryTimer !== scheduled) return;
			wakeRetryTimer = undefined;
			if (shuttingDown || epoch !== sessionEpoch) return;
			preparePendingForDelivery();
			if (latestCtx?.isIdle()) {
				completionQueue.setParentActive(false);
				completionQueue.rearm();
			} else {
				scheduleWakeRetry();
			}
		}, delay);
		unrefTimer(scheduled.handle);
	};

	const preparePendingForDelivery = () => {
		if (shuttingDown || !SAFE_SESSION_ID.test(boundSessionId)) return;
		const needsPlan = [...pendingWakes.values()].some((state) => !state.planPersisted);
		if (needsPlan) {
			if (!persistPlan()) {
				scheduleWakeRetry();
				return;
			}
			for (const state of pendingWakes.values()) state.planPersisted = true;
		}
		for (const state of pendingWakes.values()) {
			if (!state.pendingPersisted) {
				if (!appendWakeMarker(pendingWakeMarker(state.terminal, state.sequence))) {
					scheduleWakeRetry();
					continue;
				}
				state.pendingPersisted = true;
			}
			if (state.planPersisted && state.pendingPersisted) {
				completionQueue.enqueue({ id: state.run.id, run: state.run });
			}
		}
	};

	const releaseActiveDelivery = () => {
		const active = activeWakeDelivery;
		if (!active) return;
		clearTimeout(active.watchdog);
		activeWakeDelivery = undefined;
		completionQueue.release(active.notices.map((notice) => {
			const current = pendingWakes.get(notice.id);
			return { id: notice.id, run: current?.run ?? notice.run };
		}));
		scheduleWakeRetry();
	};

	completionQueue = createCompletionQueue<CompletionNotice>({
		debounceMs: extensionOptions.completionDebounceMs,
		onFlush: (items) => {
			if (shuttingDown || items.length === 0 || activeWakeDelivery) throw new Error("wake delivery unavailable");
			const deliverable = items.filter(({ id }) => {
				const state = pendingWakes.get(id);
				return Boolean(state?.pendingPersisted && state.planPersisted);
			});
			if (deliverable.length === 0) throw new Error("wake durability prerequisite missing");
			const deliveryId = `wake-${randomBytes(24).toString("hex")}`;
			const attempt = nextWakeAttempt++;
			const deliveryItems = deliverable.map(({ id }) => ({
				runId: id,
				sequence: pendingWakes.get(id)!.sequence,
			}));
			const marker = deliveryWakeMarker(boundSessionId, deliveryId, attempt, deliveryItems);
			if (!appendWakeMarker(marker)) throw new Error("wake delivery marker unavailable");
			const next = nextPendingTask(plan);
			const runSections = deliverable.map(({ run }) => [
				`Background task ${run.status}: ${run.taskId} (${run.id})`,
				`Task: ${run.taskId}`,
				`Termination: ${run.terminationReason ?? "unknown"}`,
				...(run.healthStatus || run.healthFailure
					? [`Health: ${run.healthFailure ?? run.healthStatus ?? "unknown"}`]
					: []),
				`Exit: ${run.exitCode ?? "none"}${run.signal ? ` · signal ${run.signal}` : ""}`,
				`Duration: ${runDuration(run)}`,
				`Result: ${resultSummary(run)}`,
				completionOutput(run),
			].join("\n"));
			const content = [
				"[Background task lifecycle update — continue the original user work]",
				`Durable delivery: ${marker.deliveryId} · attempt ${marker.attempt}`,
				`Durable wake id(s): ${marker.items.map((item) => item.runId).join(", ")}`,
				...runSections,
				"",
				taskPlanText(plan, { includeResults: true }),
				"",
				next
					? `Next pending task from the latest revision: ${next.id} — ${next.title}`
					: "No pending task remains in the latest revision.",
				"This is completion context, not a new user request. Delivery can be replayed; identify it by run id, sequence and attempt, reconcile idempotently, then continue the latest plan without polling the finished run.",
			].join("\n");
			const epoch = sessionEpoch;
			const watchdog = setTimeout(() => {
				if (shuttingDown || epoch !== sessionEpoch || activeWakeDelivery?.marker.deliveryId !== marker.deliveryId) return;
				releaseActiveDelivery();
			}, extensionOptions.wakeWatchdogMs);
			watchdog.unref?.();
			activeWakeDelivery = {
				marker,
				notices: deliverable,
				sentAgentGeneration: agentGeneration,
				messageStarted: false,
				successfulStop: false,
				failedResponse: false,
				watchdog,
			};
			try {
				pi.sendMessage<CompletionBatchDetails>(
					{
						customType: "background-task-completion",
						content,
						display: true,
						details: {
							runs: deliverable.map(({ run }) => ({
								id: run.id,
								taskId: run.taskId,
								name: run.taskId,
								status: run.status,
								startedAt: run.startedAt,
								finishedAt: run.finishedAt,
								terminationReason: run.terminationReason,
							})),
							planRevision: plan.revision,
							...(next ? { nextTaskId: next.id } : {}),
							wake: {
								sessionId: marker.sessionId,
								deliveryId: marker.deliveryId,
								attempt: marker.attempt,
								items: marker.items,
							},
						},
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			} catch {
				clearTimeout(watchdog);
				activeWakeDelivery = undefined;
				throw new Error("wake send failed");
			}
		},
		onError: () => {
			notifyWakeDiagnostic("Background completion was not delivered; its durable attempt remains pending for bounded-backoff retry.");
			scheduleWakeRetry();
		},
	});

	const updateRun = (snapshot: BackgroundRunSnapshot) => {
		runs.set(snapshot.id, { ...snapshot });
		pruneRuns();
		updateUi();
		webDirty = true;
		const now = Date.now();
		if (now - lastWebProgressFlushAt >= WEB_PROGRESS_FLUSH_MS) {
			lastWebProgressFlushAt = now;
			flushWebTasks();
		}
		const previous = lastProgressEventAt.get(snapshot.id) ?? 0;
		const progressAt = Math.max(snapshot.lastOutputAt ?? 0, snapshot.lastProgressAt ?? 0);
		if (snapshot.status === "running" && progressAt > 0 && now - previous >= WEB_PROGRESS_FLUSH_MS) {
			lastProgressEventAt.set(snapshot.id, now);
			emitLifecycle("progress", snapshot);
		}
	};

	const finalizePlanForRun = (run: BackgroundRunSnapshot): boolean => {
		const taskStatus = run.status === "completed"
			? "completed"
			: run.status === "stopped"
				? run.stopReason === "shutdown" ? "blocked" : "cancelled"
				: "failed";
		try {
			const nextPlan = run.terminationReason === "recovery_blocked"
				? blockTaskRecovery(plan, run.taskId, run.id)
				: finishTaskRun(plan, run.taskId, run.id, taskStatus, resultSummary(run));
			if (nextPlan === plan) return true;
			plan = nextPlan;
			return persistPlan();
		} catch {
			notifyWakeDiagnostic(`Background task ${run.taskId} could not update its durable plan; wake delivery remains blocked.`);
			return false;
		}
	};

	const dismissTimers = new Set<ReturnType<typeof setTimeout>>();

	const scheduleDismiss = (runId: string) => {
		const timer = setTimeout(() => {
			dismissTimers.delete(timer);
			const run = runs.get(runId);
			if (!run) return;
			if (run.status !== "completed" && run.status !== "failed" && run.status !== "stopped") return;
			runs.delete(runId);
			updateUi();
		}, COMPLETED_DISMISS_MS);
		timer.unref?.();
		dismissTimers.add(timer);
	};

	const handleCompletion = (
		run: BackgroundRunSnapshot,
		options: { terminal?: TerminalRunManifest; replacePending?: boolean } = {},
	) => {
		controllers.delete(run.id);
		lastProgressEventAt.delete(run.id);
		runs.set(run.id, run);
		if (branchChanging) return;
		const planPersisted = finalizePlanForRun(run);
		if (runShouldWake(run)) {
			const existing = pendingWakes.get(run.id);
			if (existing && !options.replacePending) {
				existing.run = { ...run };
				existing.planPersisted = planPersisted;
			} else {
				recordPendingWake(run, {
					terminal: options.terminal,
					planPersisted,
					replace: options.replacePending,
				});
			}
		}
		updateUi();
		flushWebRuntime("active");
		flushWebTasks();
		emitLifecycle(run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "stopped", run);
		if (!shuttingDown) preparePendingForDelivery();
		if (!shuttingDown) scheduleDismiss(run.id);
	};

	const lostMonitorRun = (ctx: ExtensionContext, task: TaskPlan["tasks"][number]): BackgroundRunSnapshot => {
		const now = Date.now();
		return {
			recordVersion: BACKGROUND_RUN_RECORD_VERSION,
			id: task.runId!,
			taskId: task.id,
			name: task.id,
			status: "failed",
			cwd: ctx.cwd,
			createdAt: now,
			startedAt: now,
			finishedAt: now,
			timeoutAt: now,
			terminationReason: "monitor_restarted",
			stdoutTail: "",
			stderrTail: "",
			logTruncated: false,
			error: "The managed monitor restarted without a trusted terminal manifest; ownership cannot be safely reattached and external cleanup must be verified before retrying.",
			manifestPersisted: false,
		};
	};

	const recoveryBlockedRun = (
		ctx: ExtensionContext,
		task: TaskPlan["tasks"][number],
		code: TerminalManifestFailureCode | "marker_mismatch",
	): BackgroundRunSnapshot => {
		const now = Date.now();
		return {
			recordVersion: BACKGROUND_RUN_RECORD_VERSION,
			id: task.runId!,
			taskId: task.id,
			name: task.id,
			status: "failed",
			cwd: ctx.cwd,
			createdAt: now,
			startedAt: now,
			finishedAt: now,
			timeoutAt: now,
			terminationReason: "recovery_blocked",
			stdoutTail: "",
			stderrTail: "",
			logTruncated: false,
			error: `Secure terminal recovery was blocked (${code}); no legacy or unbound result was trusted.`,
			manifestPersisted: false,
		};
	};

	const sameTerminalManifest = (left: TerminalRunManifest, right: TerminalRunManifest): boolean => {
		const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
		return keys.every((key) => (left as unknown as Record<string, unknown>)[key] === (right as unknown as Record<string, unknown>)[key]);
	};

	const manifestRequiredForWake = (terminal: TerminalRunManifest): boolean => ![
		"monitor_restarted",
		"recovery_blocked",
		"persistence_failed",
	].includes(terminal.terminationReason);

	const recoverDurableRuns = async (ctx: ExtensionContext) => {
		for (const task of [...plan.tasks]) {
			if (!task.runId) continue;
			const pending = pendingWakes.get(task.runId);
			if (pending) {
				if (manifestRequiredForWake(pending.terminal)) {
					const verified = await readTerminalRunManifest(extensionOptions.runsDir, {
						sessionId: boundSessionId,
						runId: task.runId,
						taskId: task.id,
					});
					if (!verified.ok || !sameTerminalManifest(verified.manifest, pending.terminal)) {
						const blocked = recoveryBlockedRun(ctx, task, verified.ok ? "marker_mismatch" : verified.code);
						handleCompletion(blocked, { replacePending: true });
						continue;
					}
				}
				runs.set(pending.run.id, pending.run);
				if (task.status === "in_progress") handleCompletion(pending.run);
				continue;
			}

			const result = await readTerminalRunManifest(extensionOptions.runsDir, {
				sessionId: boundSessionId,
				runId: task.runId,
				taskId: task.id,
			});
			if (task.status === "in_progress") {
				if (result.ok) {
					const recovered = snapshotFromTerminalManifest(result.manifest, ctx.cwd);
					handleCompletion(recovered, { terminal: result.manifest });
				} else {
					handleCompletion(lostMonitorRun(ctx, task));
				}
				continue;
			}
			if (!result.ok) {
				const acknowledgedTerminal = acknowledgedWakeTerminals.get(task.runId);
				if ((task.status === "blocked" && knownWakeRunIds.has(task.runId))
					|| (acknowledgedTerminal && !manifestRequiredForWake(acknowledgedTerminal))) continue;
				handleCompletion(recoveryBlockedRun(ctx, task, result.code), { replacePending: true });
				continue;
			}
			const recovered = snapshotFromTerminalManifest(result.manifest, ctx.cwd);
			runs.set(recovered.id, recovered);
			if (runShouldWake(recovered) && !knownWakeRunIds.has(task.runId)) {
				handleCompletion(recovered, { terminal: result.manifest });
			}
		}
	};

	const findController = (id: string): { id: string; controller: BackgroundRunController } | undefined => {
		const exact = controllers.get(id);
		if (exact) return { id, controller: exact };
		for (const [runId, controller] of controllers) {
			if (controller.snapshot().taskId === id) return { id: runId, controller };
		}
		return undefined;
	};

	const stopOne = (id: string, reason: "user" | "shutdown" = "user"): boolean => {
		const found = findController(id);
		if (!found) return false;
		const stopped = found.controller.stop(reason);
		if (stopped) updateRun(found.controller.snapshot());
		return stopped;
	};

	const stopAll = (reason: "user" | "shutdown" = "user"): number => {
		let stopped = 0;
		for (const [id] of controllers) if (stopOne(id, reason)) stopped += 1;
		return stopped;
	};

	pi.registerMessageRenderer<CompletionBatchDetails>(
		"background-task-completion",
		(message, _options, theme) => {
			const details = message.details;
			if (!details) return new Text(typeof message.content === "string" ? message.content : "Background task completed", 0, 0);
			const lines = details.runs.map((run) => {
				const icon = run.status === "completed" ? theme.fg("success", "✓") : run.status === "failed" ? theme.fg("error", "✗") : theme.fg("warning", "■");
				return `${icon} ${theme.bold(run.name)} · ${run.status} · ${runDuration(run)}`;
			});
			lines.push(theme.fg("dim", `plan revision ${details.planRevision}${details.nextTaskId ? ` · next ${details.nextTaskId}` : " · no pending task"}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	);

	pi.registerTool({
		name: "update_task_plan",
		label: "Update Task Plan",
		description: "Create or dynamically reconcile the ordered current-goal task plan. Use the latest revision; stale updates are rejected so user prompts and background completions cannot overwrite each other.",
		promptSnippet: "Maintain a dynamic Codex-style task list with revision conflict protection",
		promptGuidelines: [
			"For multi-step work, call update_task_plan with concise ordered tasks and keep it current as user prompts add, remove, reprioritize, complete, fail, or retry work.",
			"Treat the task plan as the current user's goal, not permanent history. Omit terminal or obsolete tasks once they no longer materially affect the next analysis, retry, verification, or decision; keep them explicitly only while still relevant.",
			"Use the task-plan revision in the latest task-plan snapshot or subsequent tool/lifecycle result as baseRevision (use 0 for the initial empty plan). If a revision conflict occurs, reconcile against the returned latest plan rather than overwriting it.",
			"Keep at most one task in_progress. Do not mark a managed background task complete yourself; its lifecycle hook owns the terminal transition.",
		],
		parameters: UpdateTaskPlanParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			try {
				plan = reconcileTaskPlan(
					plan,
					Math.floor(params.baseRevision),
					params.tasks as TaskPlanInput[],
					params.explanation ?? "",
				);
			} catch (error) {
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nLatest plan:\n${taskPlanText(plan, { includeResults: true })}`);
			}
			if (!persistPlan()) throw new Error("Task plan changed in memory but secure session persistence failed; retry with the latest revision.");
			return {
				content: [{ type: "text", text: taskPlanText(plan, { includeResults: true }) }],
				details: { plan } satisfies UpdatePlanDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("update_task_plan"))}${theme.fg("dim", ` · base revision ${args.baseRevision} · ${args.tasks.length} task(s)`)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as UpdatePlanDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "Task plan unavailable"), 0, 0);
			const pending = details.plan.tasks.filter((task) => task.status === "pending").length;
			const done = details.plan.tasks.filter((task) => task.status === "completed").length;
			return new Text(theme.fg("accent", `tasks revision ${details.plan.revision}`) + theme.fg("dim", ` · ${pending} pending · ${done} completed`), 0, 0);
		},
	});

	pi.registerTool({
		name: "run_background_task",
		label: "Run Background Task",
		description: "Start a long shell command under the main-agent background monitor. Returns immediately; exit, failure, signal, wall timeout, or an opt-in fail-closed health policy updates the task plan and durably wakes the main LLM.",
		promptSnippet: "Launch a managed background command with durable completion wake and optional health lease",
		promptGuidelines: [
			"Use run_background_task for long benchmarks, tests, builds, deployments, training or data jobs that should continue after the current turn. The command must stay in the foreground of its managed shell; never use raw '&', nohup, disown, daemonize flags, or PID polling for such work.",
			"Create/update the task plan first and bind the exact taskId. The tool returns immediately; do not poll. Continue only useful non-conflicting work or end the turn and wait for the lifecycle wake.",
			"For adoption watchers, remote supervisors, or other commands that can stay alive while observed work is unavailable or stale, pass run_background_task.healthPolicy and emit JSON Lines health records on dedicated fd 3. Do not rely on human log parsing; report version=1, health=healthy|unavailable, and an opaque progress token when staleness is bounded.",
			"User prompts received while a background task runs may dynamically change pending tasks. Keep the active task unless the user explicitly asks to stop or replace it.",
		],
		parameters: RunBackgroundTaskParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestCtx = ctx;
			if (shuttingDown) throw new Error("session is shutting down");
			if (signal?.aborted) throw new Error("background task launch was aborted");
			if (activeRuns().length > 0) throw new Error(`a managed background task is already running: ${activeRuns()[0].id}`);
			const command = params.command.trim();
			if (!command) throw new Error("command is required");
			if (command.length > MAX_COMMAND_CHARS) throw new Error(`command exceeds ${MAX_COMMAND_CHARS} characters`);
			const taskId = params.taskId.trim().toLowerCase();
			const name = safeRunName(params.name ?? taskId);
			if (!SAFE_SESSION_ID.test(boundSessionId) || ctx.sessionManager.getSessionId() !== boundSessionId) {
				throw new Error("secure session binding unavailable");
			}
			const id = `bg-${randomBytes(16).toString("hex")}`;
			const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
			const timeoutMs = clampTimeout(params.timeoutMs);
			const healthPolicy = normalizeHealthPolicy(params.healthPolicy);
			const previousPlan = plan;
			plan = attachRunToTask(plan, taskId, id, plan.tasks.find((task) => task.id === taskId)?.title ?? name);
			if (!persistPlan()) {
				plan = previousPlan;
				updateUi();
				throw new Error("background launch blocked because its plan binding could not be securely persisted");
			}
			let controller: BackgroundRunController;
			try {
				controller = await extensionOptions.startRun({
					id,
					taskId,
					name,
					command,
					cwd,
					runsDir: extensionOptions.runsDir,
					sessionId: boundSessionId,
					timeoutMs,
					healthPolicy,
					terminateGraceMs: TERMINATE_GRACE_MS,
					killConfirmMs: extensionOptions.killConfirmMs,
					maxTailBytes: MAX_TAIL_BYTES,
					onUpdate: updateRun,
				});
			} catch {
				const observedAt = Date.now();
				const failed: BackgroundRunSnapshot = {
					recordVersion: BACKGROUND_RUN_RECORD_VERSION,
					id,
					taskId,
					name,
					status: "failed",
					cwd,
					createdAt: observedAt,
					startedAt: observedAt,
					finishedAt: observedAt,
					timeoutAt: observedAt + timeoutMs,
					...(healthPolicy ? { healthPolicy, healthStatus: "awaiting" as const } : {}),
					terminationReason: "persistence_failed",
					stdoutTail: "",
					stderrTail: "",
					logTruncated: false,
					error: "Secure run setup failed before process ownership was established.",
					manifestPersisted: false,
				};
				handleCompletion(failed);
				throw new Error("secure background run setup failed");
			}
			controllers.set(id, controller);
			const initial = controller.snapshot();
			runs.set(id, initial);
			updateUi();
			flushWebRuntime("active");
			flushWebTasks();
			emitLifecycle("started", initial);
			void controller.completion.then(handleCompletion);
			onUpdate?.({
				content: [{ type: "text", text: `Managed background task ${name} started (${id}). Monitoring exit, failure, signal, wall timeout${healthPolicy ? ", health availability and structured progress" : ""}.` }],
				details: runDetails(initial, plan.revision),
			});
			return {
				content: [{
					type: "text",
					text: [
						`Background task started: ${name} (${id})`,
						`Task plan id: ${taskId}`,
						`Plan revision: ${plan.revision}`,
						`Timeout: ${timeoutMs}ms`,
						...(healthPolicy ? [
							`Health policy: startup ${healthPolicy.startupGraceMs}ms · heartbeat ${healthPolicy.heartbeatTimeoutMs}ms · unavailable ${healthPolicy.unavailableTimeoutMs}ms${healthPolicy.staleProgressTimeoutMs ? ` · stale progress ${healthPolicy.staleProgressTimeoutMs}ms` : ""}`,
							"Health protocol: write one JSON object per line to fd 3 (also exposed as PI_BACKGROUND_TASK_HEALTH_FD).",
						] : []),
						"Console output is retained only as a bounded in-memory tail for the completion message.",
						"Completion is durably classified, updates the plan, and wakes the main agent automatically. Do not poll.",
					].join("\n"),
				}],
				details: runDetails(initial, plan.revision),
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("run_background_task"))} ${theme.fg("accent", args.name ?? args.taskId)}\n${theme.fg("dim", args.command.slice(0, 160))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "Background launch unavailable"), 0, 0);
			return new Text(`${theme.fg("warning", "●")} ${theme.fg("accent", details.run.name)} ${theme.fg("dim", `running · ${details.run.id} · plan revision ${details.planRevision}`)}`, 0, 0);
		},
	});

	pi.registerTool({
		name: "stop_background_task",
		label: "Stop Background Task",
		description: "Stop an exact managed background run by run id or task id. Sends TERM to its owned process group, then KILL after the grace period if needed.",
		promptSnippet: "Stop a managed main-agent background command by exact run or task id",
		parameters: StopBackgroundTaskParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const stopped = stopOne(params.id, "user");
			if (!stopped) throw new Error(`active background task not found or already stopping: ${params.id}`);
			return { content: [{ type: "text", text: `Stop initiated for ${params.id}. Terminal state will wake the main agent.` }] };
		},
	});

	pi.registerCommand("tasks", {
		description: "Inspect or stop main-agent background tasks: /tasks [stop <id|all>|clear-completed]",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const [action = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "list" || action === "open") {
				ctx.ui.notify(taskPlanText(plan, { includeResults: true }), "info");
				return;
			}
			if (action === "stop") {
				const target = rest.join(" ");
				if (target === "all" || target === "*") {
					const count = stopAll("user");
					ctx.ui.notify(count ? `Stopping ${count} background task(s)` : "No active background task", "info");
					return;
				}
				ctx.ui.notify(stopOne(target, "user") ? `Stopping ${target}` : `Active background task not found: ${target || "(missing id)"}`, target ? "info" : "warning");
				return;
			}
			if (action === "clear-completed") {
				const nextPlan = clearCompletedTaskHistory(plan);
				if (nextPlan === plan) ctx.ui.notify("No completed task history to clear", "info");
				else {
					plan = nextPlan;
					if (persistPlan()) ctx.ui.notify(`Task history cleared · revision ${plan.revision}`, "info");
					else ctx.ui.notify("Task history changed in memory but secure persistence failed; retry the command.", "error");
				}
				return;
			}
			ctx.ui.notify(`Unknown /tasks action: ${action}`, "warning");
		},
	});

	// Keep dynamic revisions out of the system prefix.
	registerContextSnapshot(pi, "background-tasks:context:v1", () => [
		"[DYNAMIC MAIN-AGENT TASK PLAN]",
		taskPlanText(plan),
		"This snapshot and subsequent task-plan/tool/lifecycle updates supersede older snapshots.",
		"User prompts may change scope or priority while a background command runs. Reconcile the plan with update_task_plan using the exact revision above. This is a current-goal view, not permanent history: omit terminal or obsolete tasks when they no longer materially affect next work, but retain outcomes still needed for analysis, retry, verification, or decisions. Keep an active managed task unless the user explicitly asks to stop or replace it. Completion hooks use the latest revision and wake you automatically; never poll managed runs.",
	].join("\n"));

	const blockBranchChange = (ctx: ExtensionContext, action: string) => {
		const active = activeRuns().length;
		if (active === 0 && pendingWakes.size === 0 && !activeWakeDelivery) return false;
		const reason = active > 0
			? "a managed background task is running. Stop it with /tasks stop first"
			: "a durable background completion wake is awaiting explicit acknowledgement";
		try { ctx.ui.notify(`Cannot ${action} while ${reason}.`, "warning"); } catch { /* best effort */ }
		return true;
	};

	const cancelWakeRuntime = () => {
		clearWakeRetryTimer();
		if (activeWakeDelivery) clearTimeout(activeWakeDelivery.watchdog);
		activeWakeDelivery = undefined;
		++sessionEpoch;
	};

	pi.on("session_before_switch", (_event, ctx) => blockBranchChange(ctx, "switch sessions") ? { cancel: true } : {});
	pi.on("session_before_fork", (_event, ctx) => blockBranchChange(ctx, "fork the session") ? { cancel: true } : {});
	pi.on("session_before_tree", (_event, ctx) => blockBranchChange(ctx, "navigate the session tree") ? { cancel: true } : {});

	pi.on("session_tree", async (_event, ctx) => {
		cancelWakeRuntime();
		wakeRetryRound = 0;
		completionQueue.clear();
		if (activeRuns().length > 0) {
			branchChanging = true;
			const activeControllers = [...controllers.values()];
			stopAll("shutdown");
			await Promise.all(activeControllers.map((controller) => controller.completion));
			branchChanging = false;
		}
		pendingWakes.clear();
		acknowledgedWakeTerminals.clear();
		knownWakeRunIds.clear();
		runs.clear();
		const branch = ctx.sessionManager.getBranch() as any[];
		plan = reconstructTaskPlan(branch, Date.now(), boundSessionId);
		if (SAFE_SESSION_ID.test(boundSessionId)) {
			const wakeState = reconstructWakeOutbox(branch, boundSessionId);
			nextWakeSequence = wakeState.nextSequence;
			nextWakeAttempt = wakeState.maxAttempt + 1;
			for (const runId of wakeState.knownRunIds) knownWakeRunIds.add(runId);
			for (const [runId, terminal] of wakeState.acknowledged) acknowledgedWakeTerminals.set(runId, terminal);
			for (const pending of wakeState.pending.values()) {
				const run = snapshotFromTerminalManifest(pending.terminal, ctx.cwd);
				recordPendingWake(run, {
					terminal: pending.terminal,
					restored: true,
					sequence: pending.sequence,
					planPersisted: true,
				});
			}
			await recoverDurableRuns(ctx);
			preparePendingForDelivery();
		}
		updateUi();
		flushWebTasks();
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		shuttingDown = false;
		branchChanging = false;
		cancelWakeRuntime();
		boundSessionId = ctx.sessionManager.getSessionId();
		agentGeneration = 0;
		wakeRetryRound = 0;
		lastWakeDiagnosticAt = 0;
		pendingWakes.clear();
		acknowledgedWakeTerminals.clear();
		knownWakeRunIds.clear();
		runs.clear();
		completionQueue.setParentActive(false);
		const branch = ctx.sessionManager.getBranch() as any[];
		if (!SAFE_SESSION_ID.test(boundSessionId)) {
			plan = reconstructTaskPlan(branch);
			notifyWakeDiagnostic("Background recovery is disabled because Pi did not provide a safe, stable session identity.");
			updateUi();
			void startWebActivity(ctx);
			return;
		}
		plan = reconstructTaskPlan(branch, Date.now(), boundSessionId);
		const wakeState = reconstructWakeOutbox(branch, boundSessionId);
		nextWakeSequence = wakeState.nextSequence;
		nextWakeAttempt = wakeState.maxAttempt + 1;
		for (const runId of wakeState.knownRunIds) knownWakeRunIds.add(runId);
		for (const [runId, terminal] of wakeState.acknowledged) acknowledgedWakeTerminals.set(runId, terminal);
		for (const [runId, pending] of wakeState.pending) {
			const run = snapshotFromTerminalManifest(pending.terminal, ctx.cwd);
			recordPendingWake(run, {
				terminal: pending.terminal,
				restored: true,
				sequence: pending.sequence,
				planPersisted: true,
			});
			runs.set(runId, run);
		}
		if (wakeState.invalidMarkerCount > 0) {
			notifyWakeDiagnostic("One or more invalid or mismatched background wake markers were rejected.");
		}
		await recoverDurableRuns(ctx);
		preparePendingForDelivery();
		updateUi();
		void startWebActivity(ctx);
	});

	pi.on("agent_start", () => {
		agentGeneration += 1;
		completionQueue.setParentActive(true);
		const active = activeWakeDelivery;
		if (!active) return;
		if (active.boundAgentGeneration !== undefined) {
			active.failedResponse = true;
			active.successfulStop = false;
			return;
		}
		if (active.messageStarted && agentGeneration > active.sentAgentGeneration) {
			active.boundAgentGeneration = agentGeneration;
			clearTimeout(active.watchdog);
		}
	});

	pi.on("message_start", (event) => {
		if (event.message.role !== "custom" || event.message.customType !== "background-task-completion") return;
		const details = event.message.details as CompletionBatchDetails | undefined;
		const active = activeWakeDelivery;
		if (!details?.wake || !active) return;
		const expected = active.marker;
		const actual = details.wake;
		const matchingItems = actual.items.length === expected.items.length && expected.items.every((item, index) => (
			item.runId === actual.items[index]?.runId && item.sequence === actual.items[index]?.sequence
		));
		if (actual.sessionId !== boundSessionId
			|| actual.deliveryId !== expected.deliveryId
			|| actual.attempt !== expected.attempt
			|| !matchingItems) return;
		if (expected.items.some((item) => pendingWakes.get(item.runId)?.sequence !== item.sequence)) return;
		active.messageStarted = true;
		if (agentGeneration > active.sentAgentGeneration) {
			active.boundAgentGeneration = agentGeneration;
			clearTimeout(active.watchdog);
		}
	});

	pi.on("message_end", (event) => {
		const active = activeWakeDelivery;
		if (!active || event.message.role !== "assistant" || active.boundAgentGeneration !== agentGeneration) return;
		if (event.message.stopReason === "stop") {
			if (!active.failedResponse) active.successfulStop = true;
			return;
		}
		if (event.message.stopReason === "length" || event.message.stopReason === "error" || event.message.stopReason === "aborted") {
			active.failedResponse = true;
			active.successfulStop = false;
		}
		// toolUse is an intermediate response and can never acknowledge delivery.
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!ctx.isIdle()) return;
		const active = activeWakeDelivery;
		if (active) {
			const canAcknowledge = active.messageStarted
				&& active.boundAgentGeneration !== undefined
				&& active.successfulStop
				&& !active.failedResponse
				&& active.marker.items.every((item) => pendingWakes.get(item.runId)?.sequence === item.sequence);
			if (canAcknowledge && appendWakeMarker(acknowledgedWakeMarker(active.marker))) {
				clearTimeout(active.watchdog);
				activeWakeDelivery = undefined;
				for (const item of active.marker.items) {
					const pending = pendingWakes.get(item.runId);
					if (pending) acknowledgedWakeTerminals.set(item.runId, pending.terminal);
					pendingWakes.delete(item.runId);
					knownWakeRunIds.add(item.runId);
				}
				completionQueue.acknowledge(active.marker.items.map((item) => item.runId));
				wakeRetryRound = 0;
			} else {
				releaseActiveDelivery();
			}
		}
		if (wakeRetryTimer === undefined) {
			completionQueue.setParentActive(false);
			preparePendingForDelivery();
			completionQueue.rearm();
		}
	});

	pi.on("session_shutdown", async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		cancelWakeRuntime();
		++webEpoch;
		for (const timer of dismissTimers) clearTimeout(timer);
		dismissTimers.clear();
		completionQueue.stop();
		stopWebHeartbeat();
		clearUiExpiryTimer();
		stopAll("shutdown");
		await Promise.all([...controllers.values()].map((controller) => controller.completion));
		try {
			const writes: Promise<boolean>[] = [];
			const tasksWrite = flushWebTasks();
			if (tasksWrite) writes.push(tasksWrite);
			const runtimeWrite = flushWebRuntime("shutdown");
			if (runtimeWrite) writes.push(runtimeWrite);
			await Promise.all(writes);
		} catch {
			// Observability never blocks teardown.
		}
		if (latestCtx?.hasUI) {
			try {
				releaseActivityWidgetSection(latestCtx.ui, activityWidgetOwner);
				latestCtx.ui.setStatus("background-tasks", undefined);
			} catch { /* UI already gone */ }
		}
		webRegistry = undefined;
		boundSessionId = "";
		latestCtx = undefined;
	});
}

export default createBackgroundTasksExtension();
