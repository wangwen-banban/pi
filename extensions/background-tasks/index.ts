import { randomBytes, randomUUID } from "node:crypto";
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
import { createCompletionQueue } from "./completion-queue.ts";
import {
	COMPLETED_TASK_HOLD_MS,
	TASK_PLAN_MARKER_TYPE,
	TASK_STATUSES,
	attachRunToTask,
	clearCompletedTaskHistory,
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
	startManagedBackgroundRun,
	type BackgroundRunController,
	type BackgroundRunSnapshot,
} from "./runner.ts";
import {
	buildBackgroundRuntimeRecord,
	buildBackgroundTasksRecord,
} from "./web-record.ts";

const DEFAULT_RUNS_DIR = path.join(getAgentDir(), "background-task-runs");
const DEFAULT_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000;
const TERMINATE_GRACE_MS = 5_000;
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_TAIL_BYTES = 32 * 1024;
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

const RunBackgroundTaskParams = Type.Object({
	taskId: Type.String({ description: "Task-plan id to mark in_progress and bind to this run." }),
	name: Type.Optional(Type.String({ description: "Short run name shown in activity; defaults to taskId." })),
	command: Type.String({ description: "Shell command to run under the managed background monitor." }),
	cwd: Type.Optional(Type.String({ description: "Working directory, relative to the session cwd unless absolute." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Wall-clock timeout in milliseconds. Default 6 hours; range 1 second–7 days." })),
});

const StopBackgroundTaskParams = Type.Object({
	id: Type.String({ description: "Exact run id or task id to stop." }),
});

interface UpdatePlanDetails {
	plan: TaskPlan;
}

interface RunDetails {
	run: BackgroundRunSnapshot;
	plan: TaskPlan;
}

interface CompletionNotice {
	id: string;
	run: BackgroundRunSnapshot;
}

interface CompletionBatchDetails {
	runs: BackgroundRunSnapshot[];
	plan: TaskPlan;
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

function runDuration(run: BackgroundRunSnapshot): string {
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

export interface BackgroundTasksExtensionOptions {
	runsDir?: string;
	startRun?: typeof startManagedBackgroundRun;
	completionDebounceMs?: number;
	completedTaskHoldMs?: number;
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
	};
	return function backgroundTasks(pi: ExtensionAPI) {
		registerBackgroundTasks(pi, resolved);
	};
}

function registerBackgroundTasks(pi: ExtensionAPI, extensionOptions: ResolvedBackgroundTasksExtensionOptions) {
	let plan = emptyTaskPlan();
	let latestCtx: ExtensionContext | undefined;
	let shuttingDown = false;
	let sequence = 0;
	const controllers = new Map<string, BackgroundRunController>();
	const runs = new Map<string, BackgroundRunSnapshot>();
	const lastProgressEventAt = new Map<string, number>();

	let webRegistry: WebActivityRegistry | undefined;
	let webRuntimeId = "";
	let webGeneration = 0;
	let webStartedAt = 0;
	let webEpoch = 0;
	let webHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let lastWebProgressFlushAt = 0;
	let webDirty = false;
	let uiExpiryTimer: ReturnType<typeof setTimeout> | undefined;

	const currentSessionId = () => latestCtx?.sessionManager.getSessionId() ?? "";
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
			ctx.ui.setWidget("background-tasks", undefined);
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
		ctx.ui.setWidget("background-tasks", lines, { placement: "aboveEditor" });
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

	const flushWebTasks = (): Promise<boolean> | undefined => {
		webDirty = false;
		if (!webRegistry || !latestCtx) return undefined;
		return webRegistry.write("background-tasks", buildBackgroundTasksRecord(plan, [...runs.values()], webIdentity()));
	};

	const flushWebRuntime = (state: "active" | "shutdown" = "active"): Promise<boolean> | undefined => {
		if (!webRegistry || !latestCtx) return undefined;
		return webRegistry.write("runtime", buildBackgroundRuntimeRecord(
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

	const persistPlan = () => {
		try { pi.appendEntry(TASK_PLAN_MARKER_TYPE, plan); } catch { /* stale session during teardown */ }
		updateUi();
		flushWebTasks();
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

	const completionQueue = createCompletionQueue<CompletionNotice>({
		debounceMs: extensionOptions.completionDebounceMs,
		onFlush: (items) => {
			if (shuttingDown || items.length === 0) return;
			const next = nextPendingTask(plan);
			const runSections = items.map(({ run }) => [
				`Background task ${run.status}: ${run.name} (${run.id})`,
				`Task: ${run.taskId}`,
				`Termination: ${run.terminationReason ?? "unknown"}`,
				`Exit: ${run.exitCode ?? "none"}${run.signal ? ` · signal ${run.signal}` : ""}`,
				`Duration: ${runDuration(run)}`,
				`Logs: ${run.stdoutPath} · ${run.stderrPath}`,
				completionOutput(run),
			].join("\n"));
			const content = [
				"[Background task lifecycle update — continue the original user work]",
				...runSections,
				"",
				taskPlanText(plan, { includeResults: true }),
				"",
				next
					? `Next pending task from the latest revision: ${next.id} — ${next.title}`
					: "No pending task remains in the latest revision.",
				"This is completion context, not a new user request. Reconcile any user prompts received while the command ran, analyze the result, update the task plan with the current revision, and continue. Do not poll a finished run.",
			].join("\n");
			pi.sendMessage<CompletionBatchDetails>(
				{
					customType: "background-task-completion",
					content,
					display: true,
					details: { runs: items.map((item) => item.run), plan },
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		onError: (error) => {
			try {
				latestCtx?.ui.notify(`Could not wake main agent for background completion: ${error instanceof Error ? error.message : String(error)}`, "error");
			} catch { /* best effort */ }
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
		if (snapshot.status === "running" && snapshot.lastOutputAt && now - previous >= WEB_PROGRESS_FLUSH_MS) {
			lastProgressEventAt.set(snapshot.id, now);
			emitLifecycle("progress", snapshot);
		}
	};

	const finalizePlanForRun = (run: BackgroundRunSnapshot) => {
		const taskStatus = run.status === "completed"
			? "completed"
			: run.status === "stopped"
				? run.stopReason === "shutdown" ? "blocked" : "cancelled"
				: "failed";
		try {
			const nextPlan = finishTaskRun(plan, run.taskId, run.id, taskStatus, resultSummary(run));
			if (nextPlan !== plan) {
				plan = nextPlan;
				persistPlan();
			}
		} catch (error) {
			try { latestCtx?.ui.notify(`Could not update task ${run.taskId}: ${error instanceof Error ? error.message : String(error)}`, "error"); } catch { /* best effort */ }
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

	const handleCompletion = (run: BackgroundRunSnapshot) => {
		controllers.delete(run.id);
		lastProgressEventAt.delete(run.id);
		runs.set(run.id, run);
		finalizePlanForRun(run);
		updateUi();
		flushWebRuntime("active");
		flushWebTasks();
		emitLifecycle(run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "stopped", run);
		if (!shuttingDown) completionQueue.enqueue({ id: run.id, run });
		scheduleDismiss(run.id);
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
			const next = nextPendingTask(details.plan);
			lines.push(theme.fg("dim", `plan revision ${details.plan.revision}${next ? ` · next ${next.id}` : " · no pending task"}`));
			return new Text(lines.join("\n"), 0, 0);
		},
	);

	pi.registerTool({
		name: "update_task_plan",
		label: "Update Task Plan",
		description: "Create or dynamically reconcile the ordered main-agent task plan. Use the latest revision; stale updates are rejected so user prompts and background completions cannot overwrite each other.",
		promptSnippet: "Maintain a dynamic Codex-style task list with revision conflict protection",
		promptGuidelines: [
			"For multi-step work, call update_task_plan with concise ordered tasks and keep it current as user prompts add, remove, reprioritize, complete, fail, or retry work.",
			"Use the task-plan revision shown in the system prompt/tool result as baseRevision (use 0 for the initial empty plan). If a revision conflict occurs, reconcile against the returned latest plan rather than overwriting it.",
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
			persistPlan();
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
		description: "Start a long shell command under the main-agent background monitor. Returns immediately; exit, failure, signal or timeout updates the task plan and wakes the main LLM automatically.",
		promptSnippet: "Launch a managed background command with completion hook and automatic main-agent wake",
		promptGuidelines: [
			"Use run_background_task for long benchmarks, tests, builds, deployments, training or data jobs that should continue after the current turn. The command must stay in the foreground of its managed shell; never use raw '&', nohup, disown, daemonize flags, or PID polling for such work.",
			"Create/update the task plan first and bind the exact taskId. The tool returns immediately; do not poll. Continue only useful non-conflicting work or end the turn and wait for the lifecycle wake.",
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
			const id = `bg-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
			const cwd = params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd;
			const timeoutMs = clampTimeout(params.timeoutMs);
			plan = attachRunToTask(plan, taskId, id, plan.tasks.find((task) => task.id === taskId)?.title ?? name);
			persistPlan();
			const runDir = path.join(extensionOptions.runsDir, ctx.sessionManager.getSessionId(), id);
			let controller: BackgroundRunController;
			try {
				controller = await extensionOptions.startRun({
					id,
					taskId,
					name,
					command,
					cwd,
					runDir,
					timeoutMs,
					terminateGraceMs: TERMINATE_GRACE_MS,
					maxLogBytes: MAX_LOG_BYTES,
					maxTailBytes: MAX_TAIL_BYTES,
					onUpdate: updateRun,
				});
			} catch (error) {
				const failed: BackgroundRunSnapshot = {
					id,
					taskId,
					name,
					status: "failed",
					cwd,
					createdAt: Date.now(),
					startedAt: Date.now(),
					finishedAt: Date.now(),
					timeoutAt: Date.now() + timeoutMs,
					terminationReason: "spawn_error",
					stdoutTail: "",
					stderrTail: "",
					stdoutPath: path.join(runDir, "stdout.log"),
					stderrPath: path.join(runDir, "stderr.log"),
					resultPath: path.join(runDir, "result.json"),
					logTruncated: false,
					error: error instanceof Error ? error.message : String(error),
				};
				handleCompletion(failed);
				throw error;
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
				content: [{ type: "text", text: `Managed background task ${name} started (${id}). Monitoring exit, failure, signal and timeout.` }],
				details: { run: initial, plan } satisfies RunDetails,
			});
			return {
				content: [{
					type: "text",
					text: [
						`Background task started: ${name} (${id})`,
						`Task plan id: ${taskId}`,
						`Plan revision: ${plan.revision}`,
						`Timeout: ${timeoutMs}ms`,
						`Logs: ${initial.stdoutPath} · ${initial.stderrPath}`,
						"Completion will update the plan and wake the main agent automatically. Do not poll.",
					].join("\n"),
				}],
				details: { run: initial, plan } satisfies RunDetails,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("run_background_task"))} ${theme.fg("accent", args.name ?? args.taskId)}\n${theme.fg("dim", args.command.slice(0, 160))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as RunDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "Background launch unavailable"), 0, 0);
			return new Text(`${theme.fg("warning", "●")} ${theme.fg("accent", details.run.name)} ${theme.fg("dim", `running · ${details.run.id} · plan revision ${details.plan.revision}`)}`, 0, 0);
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
					persistPlan();
					ctx.ui.notify(`Task history cleared · revision ${plan.revision}`, "info");
				}
				return;
			}
			ctx.ui.notify(`Unknown /tasks action: ${action}`, "warning");
		},
	});

	pi.on("before_agent_start", (event) => {
		return {
			systemPrompt: [
				event.systemPrompt,
				"",
				"[DYNAMIC MAIN-AGENT TASK PLAN]",
				taskPlanText(plan),
				"User prompts may change scope or priority while a background command runs. Reconcile the plan with update_task_plan using the exact revision above. Keep an active managed task unless the user explicitly asks to stop or replace it. Completion hooks use the latest revision and wake you automatically; never poll managed runs.",
			].join("\n"),
		};
	});

	const blockBranchChange = (ctx: ExtensionContext, action: string) => {
		if (activeRuns().length === 0) return false;
		try { ctx.ui.notify(`Cannot ${action} while a managed background task is running. Stop it with /tasks stop first.`, "warning"); } catch { /* best effort */ }
		return true;
	};

	pi.on("session_before_switch", (_event, ctx) => blockBranchChange(ctx, "switch sessions") ? { cancel: true } : {});
	pi.on("session_before_fork", (_event, ctx) => blockBranchChange(ctx, "fork the session") ? { cancel: true } : {});
	pi.on("session_before_tree", (_event, ctx) => blockBranchChange(ctx, "navigate the session tree") ? { cancel: true } : {});

	pi.on("session_tree", (_event, ctx) => {
		if (activeRuns().length > 0) return;
		plan = reconstructTaskPlan(ctx.sessionManager.getBranch() as any[]);
		updateUi();
		flushWebTasks();
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		shuttingDown = false;
		completionQueue.setParentActive(false);
		plan = reconstructTaskPlan(ctx.sessionManager.getBranch() as any[]);
		updateUi();
		void startWebActivity(ctx);
	});

	pi.on("agent_start", () => {
		completionQueue.setParentActive(true);
	});

	pi.on("agent_end", () => {
		completionQueue.setParentActive(false);
	});

	pi.on("session_shutdown", async () => {
		if (shuttingDown) return;
		shuttingDown = true;
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
				latestCtx.ui.setWidget("background-tasks", undefined);
				latestCtx.ui.setStatus("background-tasks", undefined);
			} catch { /* UI already gone */ }
		}
		webRegistry = undefined;
		latestCtx = undefined;
	});
}

export default createBackgroundTasksExtension();
