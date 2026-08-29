import {
	BACKGROUND_RUN_RECORD_VERSION,
	type BackgroundRunSnapshot,
	type BackgroundRunStatus,
	type BackgroundStopReason,
	type BackgroundTerminationReason,
} from "./runner.ts";
import {
	validateBackgroundHealthPolicy,
	type BackgroundHealthFailureCode,
	type BackgroundHealthPolicy,
	type BackgroundHealthStatus,
} from "./health-policy.ts";

const RUN_STATUSES = new Set<BackgroundRunStatus>(["running", "completed", "failed", "stopped"]);
const STOP_REASONS = new Set<BackgroundStopReason>(["user", "shutdown", "timeout", "health_policy"]);
const TERMINATION_REASONS = new Set<BackgroundTerminationReason>([
	"completed",
	"exit_nonzero",
	"signal",
	"spawn_error",
	"timed_out",
	"health_policy_failed",
	"monitor_restarted",
	"explicit_stop",
	"session_shutdown",
]);
const HEALTH_STATUSES = new Set<BackgroundHealthStatus>(["awaiting", "healthy", "unavailable"]);
const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_TASK_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SAFE_RUN_NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;
const HEALTH_FAILURES = new Set<BackgroundHealthFailureCode>([
	"startup_timeout",
	"heartbeat_timeout",
	"unavailable_timeout",
	"stale_progress",
	"protocol_error",
]);

function finiteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function optionalBoundedString(value: unknown, maxBytes: number): value is string | undefined {
	return value === undefined || (typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxBytes);
}

/** Parse only the bounded terminal data needed for durable wake recovery. */
export function parseTerminalBackgroundRunSnapshot(value: unknown): BackgroundRunSnapshot | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	if (typeof raw.id !== "string" || !SAFE_RUN_ID.test(raw.id)) return undefined;
	if (typeof raw.taskId !== "string" || !SAFE_TASK_ID.test(raw.taskId)) return undefined;
	if (typeof raw.name !== "string" || !SAFE_RUN_NAME.test(raw.name)) return undefined;
	if (typeof raw.status !== "string" || !RUN_STATUSES.has(raw.status as BackgroundRunStatus) || raw.status === "running") return undefined;
	if (typeof raw.cwd !== "string" || raw.cwd.length > 8192 || CONTROL_CHARS.test(raw.cwd)) return undefined;
	for (const field of ["createdAt", "startedAt", "timeoutAt"] as const) if (!finiteNumber(raw[field])) return undefined;
	for (const field of ["stdoutPath", "stderrPath", "resultPath"] as const) {
		if (typeof raw[field] !== "string" || raw[field].length > 8192 || CONTROL_CHARS.test(raw[field])) return undefined;
	}
	if (!optionalBoundedString(raw.stdoutTail, 1024 * 1024) || !optionalBoundedString(raw.stderrTail, 1024 * 1024)) return undefined;
	if (typeof raw.logTruncated !== "boolean") return undefined;
	if (raw.terminationReason !== undefined && (typeof raw.terminationReason !== "string" || !TERMINATION_REASONS.has(raw.terminationReason as BackgroundTerminationReason))) return undefined;
	if (raw.stopReason !== undefined && (typeof raw.stopReason !== "string" || !STOP_REASONS.has(raw.stopReason as BackgroundStopReason))) return undefined;
	if (raw.healthStatus !== undefined && (typeof raw.healthStatus !== "string" || !HEALTH_STATUSES.has(raw.healthStatus as BackgroundHealthStatus))) return undefined;
	if (raw.healthFailure !== undefined && (typeof raw.healthFailure !== "string" || !HEALTH_FAILURES.has(raw.healthFailure as BackgroundHealthFailureCode))) return undefined;
	if (!optionalBoundedString(raw.signal, 64) || !optionalBoundedString(raw.error, 64 * 1024)) return undefined;
	for (const field of ["finishedAt", "lastOutputAt", "healthDeadlineAt", "lastHeartbeatAt", "lastProgressAt", "unavailableSince"] as const) {
		if (raw[field] !== undefined && !finiteNumber(raw[field])) return undefined;
	}
	if (raw.exitCode !== undefined && (!Number.isSafeInteger(raw.exitCode) || typeof raw.exitCode !== "number")) return undefined;
	let parsedHealthPolicy: BackgroundHealthPolicy | undefined;
	if (raw.healthPolicy !== undefined) {
		try { parsedHealthPolicy = validateBackgroundHealthPolicy(raw.healthPolicy as BackgroundHealthPolicy); } catch { return undefined; }
	}
	return {
		...(raw.recordVersion === BACKGROUND_RUN_RECORD_VERSION ? { recordVersion: BACKGROUND_RUN_RECORD_VERSION } : {}),
		id: raw.id,
		taskId: raw.taskId,
		name: raw.name,
		status: raw.status as BackgroundRunStatus,
		cwd: raw.cwd,
		createdAt: raw.createdAt as number,
		startedAt: raw.startedAt as number,
		...(raw.finishedAt === undefined ? {} : { finishedAt: raw.finishedAt as number }),
		...(raw.lastOutputAt === undefined ? {} : { lastOutputAt: raw.lastOutputAt as number }),
		timeoutAt: raw.timeoutAt as number,
		...(parsedHealthPolicy ? { healthPolicy: parsedHealthPolicy } : {}),
		...(raw.healthStatus === undefined ? {} : { healthStatus: raw.healthStatus as BackgroundHealthStatus }),
		...(raw.healthFailure === undefined ? {} : { healthFailure: raw.healthFailure as BackgroundHealthFailureCode }),
		...(raw.healthDeadlineAt === undefined ? {} : { healthDeadlineAt: raw.healthDeadlineAt as number }),
		...(raw.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: raw.lastHeartbeatAt as number }),
		...(raw.lastProgressAt === undefined ? {} : { lastProgressAt: raw.lastProgressAt as number }),
		...(raw.unavailableSince === undefined ? {} : { unavailableSince: raw.unavailableSince as number }),
		...(raw.exitCode === undefined ? {} : { exitCode: raw.exitCode as number }),
		...(raw.signal === undefined ? {} : { signal: raw.signal as string }),
		...(raw.terminationReason === undefined ? {} : { terminationReason: raw.terminationReason as BackgroundTerminationReason }),
		...(raw.stopReason === undefined ? {} : { stopReason: raw.stopReason as BackgroundStopReason }),
		...(raw.terminationEscalated === true ? { terminationEscalated: true } : {}),
		...(raw.timeoutEscalated === true ? { timeoutEscalated: true } : {}),
		stdoutTail: (raw.stdoutTail as string | undefined) ?? "",
		stderrTail: (raw.stderrTail as string | undefined) ?? "",
		stdoutPath: raw.stdoutPath as string,
		stderrPath: raw.stderrPath as string,
		resultPath: raw.resultPath as string,
		logTruncated: raw.logTruncated,
		...(raw.error === undefined ? {} : { error: raw.error as string }),
	};
}
