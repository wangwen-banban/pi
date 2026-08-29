export const BACKGROUND_HEALTH_PROTOCOL_VERSION = 1;
export const MAX_HEALTH_REPORT_BYTES = 16 * 1024;

export type BackgroundHealthStatus = "awaiting" | "healthy" | "unavailable";
export type BackgroundHealthFailureCode =
	| "startup_timeout"
	| "heartbeat_timeout"
	| "unavailable_timeout"
	| "stale_progress"
	| "protocol_error";

/**
 * Opt-in fail-closed contract for commands that monitor work outside of the
 * owned local process. The command reports machine-readable health records on
 * its dedicated control fd; none of these semantics are inferred from logs.
 */
export interface BackgroundHealthPolicy {
	startupGraceMs: number;
	heartbeatTimeoutMs: number;
	unavailableTimeoutMs: number;
	staleProgressTimeoutMs?: number;
}

export interface BackgroundHealthReport {
	version: typeof BACKGROUND_HEALTH_PROTOCOL_VERSION;
	health: "healthy" | "unavailable";
	progress?: string | number;
}

export interface BackgroundHealthFailure {
	code: BackgroundHealthFailureCode;
	at: number;
	detail?: string;
}

export interface BackgroundHealthSnapshot {
	status: BackgroundHealthStatus;
	lastHeartbeatAt?: number;
	lastProgressAt?: number;
	unavailableSince?: number;
	deadlineAt: number;
	failure?: BackgroundHealthFailure;
}

function positiveDuration(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${field} must be a positive integer`);
	}
	return value;
}

export function validateBackgroundHealthPolicy(value: BackgroundHealthPolicy): BackgroundHealthPolicy {
	if (!value || typeof value !== "object") throw new Error("healthPolicy must be an object");
	return {
		startupGraceMs: positiveDuration(value.startupGraceMs, "healthPolicy.startupGraceMs"),
		heartbeatTimeoutMs: positiveDuration(value.heartbeatTimeoutMs, "healthPolicy.heartbeatTimeoutMs"),
		unavailableTimeoutMs: positiveDuration(value.unavailableTimeoutMs, "healthPolicy.unavailableTimeoutMs"),
		...(value.staleProgressTimeoutMs === undefined
			? {}
			: { staleProgressTimeoutMs: positiveDuration(value.staleProgressTimeoutMs, "healthPolicy.staleProgressTimeoutMs") }),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBackgroundHealthReport(line: string): BackgroundHealthReport {
	if (Buffer.byteLength(line, "utf8") > MAX_HEALTH_REPORT_BYTES) {
		throw new Error(`health report exceeds ${MAX_HEALTH_REPORT_BYTES} bytes`);
	}
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error("health report is not valid JSON");
	}
	if (!isRecord(value) || value.version !== BACKGROUND_HEALTH_PROTOCOL_VERSION) {
		throw new Error(`health report version must be ${BACKGROUND_HEALTH_PROTOCOL_VERSION}`);
	}
	if (value.health !== "healthy" && value.health !== "unavailable") {
		throw new Error('health report health must be "healthy" or "unavailable"');
	}
	let progress: string | number | undefined;
	if (value.progress !== undefined) {
		if (typeof value.progress === "string") {
			if (Buffer.byteLength(value.progress, "utf8") > 1024) throw new Error("health report progress exceeds 1024 bytes");
			progress = value.progress;
		} else if (typeof value.progress === "number" && Number.isFinite(value.progress)) {
			progress = value.progress;
		} else {
			throw new Error("health report progress must be a finite number or string");
		}
	}
	return {
		version: BACKGROUND_HEALTH_PROTOCOL_VERSION,
		health: value.health,
		...(progress === undefined ? {} : { progress }),
	};
}

function progressKey(progress: string | number | undefined): string | undefined {
	if (progress === undefined) return undefined;
	return `${typeof progress}:${String(progress)}`;
}

/** Pure state machine; the runner owns I/O and schedules checks at deadlineAt. */
export function createBackgroundHealthMonitor(policyInput: BackgroundHealthPolicy, startedAt: number) {
	const policy = validateBackgroundHealthPolicy(policyInput);
	if (!Number.isFinite(startedAt)) throw new Error("health monitor startedAt must be finite");
	let status: BackgroundHealthStatus = "awaiting";
	let lastHeartbeatAt: number | undefined;
	let lastProgressAt: number | undefined;
	let unavailableSince: number | undefined;
	let previousProgressKey: string | undefined;
	let failure: BackgroundHealthFailure | undefined;

	const candidateDeadlines = (): Array<{ at: number; code: Exclude<BackgroundHealthFailureCode, "protocol_error"> }> => {
		if (failure) return [];
		if (lastHeartbeatAt === undefined) {
			return [{ at: startedAt + policy.startupGraceMs, code: "startup_timeout" }];
		}
		const deadlines: Array<{ at: number; code: Exclude<BackgroundHealthFailureCode, "protocol_error"> }> = [
			{ at: lastHeartbeatAt + policy.heartbeatTimeoutMs, code: "heartbeat_timeout" },
		];
		if (status === "unavailable" && unavailableSince !== undefined) {
			deadlines.push({ at: unavailableSince + policy.unavailableTimeoutMs, code: "unavailable_timeout" });
		}
		if (status === "healthy" && policy.staleProgressTimeoutMs !== undefined && lastProgressAt !== undefined) {
			deadlines.push({ at: lastProgressAt + policy.staleProgressTimeoutMs, code: "stale_progress" });
		}
		return deadlines.sort((a, b) => a.at - b.at || a.code.localeCompare(b.code));
	};

	const snapshot = (): BackgroundHealthSnapshot => ({
		status,
		...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
		...(lastProgressAt === undefined ? {} : { lastProgressAt }),
		...(unavailableSince === undefined ? {} : { unavailableSince }),
		deadlineAt: failure?.at ?? candidateDeadlines()[0]?.at ?? startedAt,
		...(failure === undefined ? {} : { failure: { ...failure } }),
	});

	const evaluate = (at: number): BackgroundHealthSnapshot => {
		if (!Number.isFinite(at)) throw new Error("health evaluation time must be finite");
		if (!failure) {
			const expired = candidateDeadlines().find((candidate) => at >= candidate.at);
			if (expired) failure = { code: expired.code, at };
		}
		return snapshot();
	};

	const failProtocol = (detail: string, at: number): BackgroundHealthSnapshot => {
		if (!failure) failure = { code: "protocol_error", at, detail: detail.slice(0, 500) };
		return snapshot();
	};

	const report = (input: BackgroundHealthReport, at: number): BackgroundHealthSnapshot => {
		evaluate(at);
		if (failure) return snapshot();
		lastHeartbeatAt = at;
		const previousStatus = status;
		if (input.health === "unavailable") {
			status = "unavailable";
			if (previousStatus !== "unavailable") unavailableSince = at;
			return evaluate(at);
		}

		status = "healthy";
		unavailableSince = undefined;
		const nextProgressKey = progressKey(input.progress);
		if (nextProgressKey !== undefined && nextProgressKey !== previousProgressKey) {
			previousProgressKey = nextProgressKey;
			lastProgressAt = at;
		} else if (lastProgressAt === undefined) {
			lastProgressAt = at;
		}
		// Recovery does not erase progress age unless its token actually changed.
		// Otherwise alternating short unavailable/healthy reports could evade both
		// the continuous-unavailable and stale-progress bounds forever.
		return evaluate(at);
	};

	return {
		policy,
		report,
		evaluate,
		failProtocol,
		snapshot,
	};
}
