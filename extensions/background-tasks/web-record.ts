import { WEB_ACTIVITY_SCHEMA_VERSION } from "../web-activity/registry.ts";
import type { TaskPlan } from "./plan-state.ts";
import type { BackgroundRunSnapshot } from "./runner.ts";

export const BACKGROUND_TASK_SOURCE = "background-tasks";

export interface BackgroundWebIdentity {
	sessionId: string;
	runtimeId: string;
	generation: number;
}

export function buildBackgroundRuntimeRecord(
	identity: BackgroundWebIdentity,
	state: "active" | "shutdown",
	summary: { startedAt: number; total: number; active: number },
	now = Date.now(),
): Record<string, unknown> {
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		source: BACKGROUND_TASK_SOURCE,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		state,
		startedAt: summary.startedAt,
		updatedAt: now,
		...(state === "active" ? { heartbeatAt: now } : {}),
		jobs: { total: summary.total, active: summary.active },
	};
}

/**
 * Public workspace record. Task titles, shell commands and output remain in
 * the private session/run stores; PI WEB receives only stable ids, lifecycle
 * status and timing metadata.
 */
export function buildBackgroundTasksRecord(
	plan: TaskPlan,
	runs: BackgroundRunSnapshot[],
	identity: BackgroundWebIdentity,
	now = Date.now(),
): Record<string, unknown> {
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		revision: plan.revision,
		updatedAt: now,
		tasks: plan.tasks.map((task, position) => ({
			id: task.id,
			name: task.id,
			status: task.status,
			position,
			updatedAt: task.updatedAt,
			runId: task.runId,
		})),
		runs: runs.map((run) => ({
			id: run.id,
			taskId: run.taskId,
			name: run.name,
			status: run.status,
			stopping: Boolean(run.stopReason && run.status === "running"),
			createdAt: run.createdAt,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			lastOutputAt: run.lastOutputAt,
			timeoutAt: run.timeoutAt,
			exitCode: run.exitCode,
			signal: run.signal,
			terminationReason: run.terminationReason,
		})),
	};
}
