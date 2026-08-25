export const TASK_PLAN_MARKER_TYPE = "background-task-plan-v1";
export const TASK_PLAN_VERSION = 1;
export const MAX_TASKS = 50;
export const MAX_TASK_TITLE_CHARS = 240;
export const COMPLETED_TASK_HOLD_MS = 60_000;
export const SAFE_TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export const TASK_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"failed",
	"blocked",
	"cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskPlanItem {
	id: string;
	title: string;
	status: TaskStatus;
	updatedAt: number;
	runId?: string;
	result?: string;
}

export interface TaskPlan {
	version: typeof TASK_PLAN_VERSION;
	revision: number;
	reason: string;
	updatedAt: number;
	tasks: TaskPlanItem[];
}

export interface TaskPlanInput {
	id: string;
	title: string;
	status: TaskStatus;
}

export interface TaskPlanBranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

export function emptyTaskPlan(now = Date.now()): TaskPlan {
	return {
		version: TASK_PLAN_VERSION,
		revision: 0,
		reason: "",
		updatedAt: now,
		tasks: [],
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: unknown): value is TaskStatus {
	return typeof value === "string" && (TASK_STATUSES as readonly string[]).includes(value);
}

function cleanSingleLine(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
}

function boundedReason(value: unknown): string {
	return typeof value === "string" ? cleanSingleLine(value).slice(0, 500) : "";
}

function boundedResult(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = cleanSingleLine(value);
	return trimmed ? trimmed.slice(0, 500) : undefined;
}

function parseStoredTask(value: unknown): TaskPlanItem | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || !SAFE_TASK_ID.test(value.id)) return undefined;
	if (typeof value.title !== "string") return undefined;
	const title = cleanSingleLine(value.title).slice(0, MAX_TASK_TITLE_CHARS);
	if (!title) return undefined;
	if (!isTaskStatus(value.status)) return undefined;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	const runId = typeof value.runId === "string" && SAFE_TASK_ID.test(value.runId) ? value.runId : undefined;
	const result = boundedResult(value.result);
	return {
		id: value.id,
		title,
		status: value.status,
		updatedAt: value.updatedAt,
		...(runId === undefined ? {} : { runId }),
		...(result === undefined ? {} : { result }),
	};
}

export function parseStoredTaskPlan(value: unknown): TaskPlan | undefined {
	if (!isRecord(value) || value.version !== TASK_PLAN_VERSION) return undefined;
	if (typeof value.revision !== "number" || !Number.isSafeInteger(value.revision) || value.revision < 0) return undefined;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS) return undefined;
	const tasks: TaskPlanItem[] = [];
	const ids = new Set<string>();
	for (const rawTask of value.tasks) {
		const task = parseStoredTask(rawTask);
		if (!task || ids.has(task.id)) return undefined;
		ids.add(task.id);
		tasks.push(task);
	}
	return {
		version: TASK_PLAN_VERSION,
		revision: value.revision,
		reason: boundedReason(value.reason),
		updatedAt: value.updatedAt,
		tasks,
	};
}

export function reconstructTaskPlan(entries: TaskPlanBranchEntry[], now = Date.now()): TaskPlan {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "custom" || entry.customType !== TASK_PLAN_MARKER_TYPE) continue;
		const parsed = parseStoredTaskPlan(entry.data);
		if (parsed) return parsed;
	}
	return emptyTaskPlan(now);
}

function normalizeInputTasks(tasks: TaskPlanInput[]): TaskPlanInput[] {
	if (!Array.isArray(tasks)) throw new Error("tasks must be an array");
	if (tasks.length > MAX_TASKS) throw new Error(`task plan supports at most ${MAX_TASKS} tasks`);
	const ids = new Set<string>();
	return tasks.map((task, index) => {
		if (!task || typeof task !== "object") throw new Error(`tasks[${index}] must be an object`);
		const id = String(task.id ?? "").trim().toLowerCase();
		if (!SAFE_TASK_ID.test(id)) throw new Error(`tasks[${index}].id must match ${SAFE_TASK_ID}`);
		if (ids.has(id)) throw new Error(`duplicate task id: ${id}`);
		ids.add(id);
		const title = cleanSingleLine(String(task.title ?? ""));
		if (!title) throw new Error(`tasks[${index}].title is required`);
		if (!isTaskStatus(task.status)) throw new Error(`tasks[${index}].status is invalid`);
		return { id, title: title.slice(0, MAX_TASK_TITLE_CHARS), status: task.status };
	});
}

function activeRunTaskIds(plan: TaskPlan): Set<string> {
	return new Set(plan.tasks.filter((task) => task.status === "in_progress" && task.runId).map((task) => task.id));
}

/**
 * Replace the current goal-oriented plan. Omitted non-active tasks are dropped:
 * the transcript and private run results own history, while this list contains
 * only work still relevant to the user's latest objective. A task backed by a
 * live managed run cannot be removed or assigned a forged terminal status.
 */
export function reconcileTaskPlan(
	current: TaskPlan,
	baseRevision: number,
	inputTasks: TaskPlanInput[],
	reason = "",
	now = Date.now(),
): TaskPlan {
	if (baseRevision !== current.revision) {
		throw new Error(`task plan revision conflict: expected ${current.revision}, received ${baseRevision}`);
	}
	const desired = normalizeInputTasks(inputTasks);
	if (desired.filter((task) => task.status === "in_progress").length > 1) {
		throw new Error("task plan may have at most one in_progress task");
	}
	const previous = new Map(current.tasks.map((task) => [task.id, task]));
	const liveTaskIds = activeRunTaskIds(current);
	const next: TaskPlanItem[] = [];
	const included = new Set<string>();

	for (const task of desired) {
		const old = previous.get(task.id);
		if (liveTaskIds.has(task.id) && task.status !== "in_progress") {
			throw new Error(`task ${task.id} has an active background run; stop it before changing status`);
		}
		const preserveOutcome = old !== undefined && old.status === task.status;
		next.push({
			id: task.id,
			title: task.title,
			status: task.status,
			updatedAt: old && old.title === task.title && old.status === task.status ? old.updatedAt : now,
			...(preserveOutcome && old.runId ? { runId: old.runId } : {}),
			...(preserveOutcome && old.result ? { result: old.result } : {}),
		});
		included.add(task.id);
	}

	for (const old of current.tasks) {
		if (!included.has(old.id) && liveTaskIds.has(old.id)) {
			throw new Error(`task ${old.id} has an active background run and cannot be removed`);
		}
	}

	return {
		version: TASK_PLAN_VERSION,
		revision: current.revision + 1,
		reason: boundedReason(reason),
		updatedAt: now,
		tasks: next,
	};
}

export function attachRunToTask(
	current: TaskPlan,
	taskId: string,
	runId: string,
	title: string,
	now = Date.now(),
): TaskPlan {
	if (!SAFE_TASK_ID.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
	if (!SAFE_TASK_ID.test(runId)) throw new Error(`invalid run id: ${runId}`);
	const normalizedTitle = cleanSingleLine(title).slice(0, MAX_TASK_TITLE_CHARS);
	if (!normalizedTitle) throw new Error("task title is required");
	const existing = current.tasks.find((task) => task.id === taskId);
	if (existing?.runId && existing.status === "in_progress") throw new Error(`task ${taskId} already has an active run`);
	const otherRunning = current.tasks.find((task) => task.id !== taskId && task.status === "in_progress");
	if (otherRunning) throw new Error(`task ${otherRunning.id} is already in progress`);
	if (existing && existing.status !== "pending" && existing.status !== "in_progress") {
		throw new Error(`task ${taskId} is ${existing.status}; reset it to pending before starting a new run`);
	}
	if (!existing && current.tasks.length >= MAX_TASKS) {
		throw new Error(`task plan already contains ${MAX_TASKS} tasks; reconcile or clear history before starting ${taskId}`);
	}
	const tasks = existing
		? current.tasks.map((task) => task.id === taskId
			? { ...task, title: normalizedTitle || task.title, status: "in_progress" as const, runId, result: undefined, updatedAt: now }
			: task)
		: [...current.tasks, { id: taskId, title: normalizedTitle, status: "in_progress" as const, runId, updatedAt: now }];
	return {
		version: TASK_PLAN_VERSION,
		revision: current.revision + 1,
		reason: `Started background task ${taskId}`,
		updatedAt: now,
		tasks,
	};
}

export function finishTaskRun(
	current: TaskPlan,
	taskId: string,
	runId: string,
	status: "completed" | "failed" | "cancelled" | "blocked",
	result: string,
	now = Date.now(),
): TaskPlan {
	const task = current.tasks.find((candidate) => candidate.id === taskId);
	if (!task) throw new Error(`task not found: ${taskId}`);
	if (task.runId !== runId) throw new Error(`run identity mismatch for task ${taskId}`);
	if (task.status !== "in_progress") return current;
	return {
		version: TASK_PLAN_VERSION,
		revision: current.revision + 1,
		reason: `Background task ${taskId} ${status}`,
		updatedAt: now,
		tasks: current.tasks.map((candidate) => candidate.id === taskId
			? { ...candidate, status, result: boundedResult(result), updatedAt: now }
			: candidate),
	};
}

export function clearCompletedTaskHistory(current: TaskPlan, now = Date.now()): TaskPlan {
	const tasks = current.tasks.filter((task) => task.status !== "completed" && task.status !== "cancelled");
	if (tasks.length === current.tasks.length) return current;
	return {
		version: TASK_PLAN_VERSION,
		revision: current.revision + 1,
		reason: "Cleared completed task history",
		updatedAt: now,
		tasks,
	};
}

export function nextPendingTask(plan: TaskPlan): TaskPlanItem | undefined {
	return plan.tasks.find((task) => task.status === "pending");
}

/** Completed history remains persisted but ages out of compact live displays. */
export function taskVisibleInCompactUi(
	task: TaskPlanItem,
	now = Date.now(),
	holdMs = COMPLETED_TASK_HOLD_MS,
): boolean {
	if (task.status !== "completed") return true;
	if (!Number.isFinite(now) || !Number.isFinite(task.updatedAt) || !Number.isFinite(holdMs) || holdMs < 0) return true;
	return now - task.updatedAt < holdMs;
}

export function visibleTaskPlanItems(
	plan: TaskPlan,
	now = Date.now(),
	holdMs = COMPLETED_TASK_HOLD_MS,
): TaskPlanItem[] {
	return plan.tasks.filter((task) => taskVisibleInCompactUi(task, now, holdMs));
}

export function taskPlanText(plan: TaskPlan, options: { includeResults?: boolean } = {}): string {
	const icon: Record<TaskStatus, string> = {
		pending: "○",
		in_progress: "▶",
		completed: "✓",
		failed: "✗",
		blocked: "■",
		cancelled: "−",
	};
	const lines = [`Task plan revision ${plan.revision}`];
	for (const task of plan.tasks) {
		lines.push(`${icon[task.status]} ${task.id}: ${task.title} [${task.status}]`);
		if (options.includeResults && task.result) lines.push(`  result: ${task.result}`);
	}
	if (plan.tasks.length === 0) lines.push("(no tasks)");
	return lines.join("\n");
}
