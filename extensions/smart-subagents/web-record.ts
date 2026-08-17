/**
 * Web-visible job record builders for smart-subagents.
 *
 * These records deliberately exclude the full task text, parent context and
 * live output; everything is bounded before it reaches the registry (which
 * sanitizes again as a second line of defense).
 */

import { WEB_ACTIVITY_SCHEMA_VERSION } from "../web-activity/registry.ts";

export interface WebRecordIdentity {
	sessionId: string;
	runtimeId: string;
	generation: number;
}

export interface WebJobRouteLike {
	modelRef: string;
	modelName: string;
	providerName: string;
	effort: string;
	contextMode: string;
	permission: string;
}

export interface WebJobLike {
	id: string;
	name: string;
	status: string;
	stopRequest?: string;
	timedOutAt?: number;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	timeoutAt?: number;
	route?: WebJobRouteLike;
	progress: string[];
	changedFiles: string[];
	output?: string;
	error?: string;
	logPath?: string;
}

export const MAX_RECORD_PROGRESS_ITEMS = 8;
export const MAX_RECORD_CHANGED_FILES = 50;
export const MAX_RESULT_SUMMARY_CHARS = 2000;
export const MAX_ERROR_SUMMARY_CHARS = 1000;

/**
 * Public agents.json record. Never includes `task`, parent context, live
 * output, config secrets, or auth material.
 */
export function buildWebAgentsRecord(
	jobs: WebJobLike[],
	queue: string[],
	identity: WebRecordIdentity,
	now = Date.now(),
): Record<string, unknown> {
	return {
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		updatedAt: now,
		jobs: jobs.map((job) => {
			const queueIndex = queue.indexOf(job.id);
			return {
				id: job.id,
				name: job.name,
				status: job.status,
				stopping: Boolean(job.stopRequest || job.timedOutAt),
				queuePosition: queueIndex >= 0 ? queueIndex + 1 : undefined,
				createdAt: job.createdAt,
				startedAt: job.startedAt,
				finishedAt: job.finishedAt,
				lastOutputAt: job.lastOutputAt,
				lastProgressAt: job.lastProgressAt,
				timeoutAt: job.timeoutAt,
				model: job.route?.modelRef,
				modelName: job.route?.modelName,
				providerName: job.route?.providerName,
				thinking: job.route?.effort,
				context: job.route?.contextMode,
				permission: job.route?.permission,
				progress: job.progress.slice(-MAX_RECORD_PROGRESS_ITEMS),
				changedFiles: job.changedFiles.slice(-MAX_RECORD_CHANGED_FILES),
				resultSummary: job.output?.slice(0, MAX_RESULT_SUMMARY_CHARS),
				errorSummary: job.error?.slice(0, MAX_ERROR_SUMMARY_CHARS),
				logPath: job.logPath,
			};
		}),
	};
}

/**
 * runtime.json heartbeat. Carries the control token on purpose: it is the
 * handshake secret the browser plugin must present in control requests.
 * No PID is exposed or trusted: control binds to session/runtime/generation/token.
 */
export function buildWebRuntimeRecord(
	identity: WebRecordIdentity & { controlToken: string },
	state: "active" | "shutdown",
	summary: { startedAt: number; total: number; active: number },
	now = Date.now(),
): Record<string, unknown> {
	return {
		source: "smart-subagents",
		schemaVersion: WEB_ACTIVITY_SCHEMA_VERSION,
		sessionId: identity.sessionId,
		runtimeId: identity.runtimeId,
		generation: identity.generation,
		controlToken: identity.controlToken,
		state,
		startedAt: summary.startedAt,
		updatedAt: now,
		heartbeatAt: now,
		jobs: { total: summary.total, active: summary.active },
	};
}

/**
 * Pure guard for the startup/shutdown race around the awaited
 * `WebActivityRegistry.create`. Returns true only when the awaited create is
 * still the current startup attempt and the session has not begun shutting
 * down. A late create that resolves after shutdown (or after a newer
 * `session_start` superseded it) must not assign the registry, construct a
 * dispatcher, start timers, prune, or perform any write/poll.
 */
export function isWebActivityStartCurrent(options: {
	shuttingDown: boolean;
	epoch: number;
	currentEpoch: number;
}): boolean {
	return !options.shuttingDown && options.epoch === options.currentEpoch;
}
