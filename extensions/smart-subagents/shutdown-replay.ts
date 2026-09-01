/**
 * Pure, fail-closed recovery of completion notifications intentionally skipped
 * during `session_shutdown`. Only entries on the caller-provided active branch
 * are considered; workers and live runtime state are never reconstructed.
 */

export const SHUTDOWN_REPLAY_REASON =
	"Stopped by the previous session shutdown; replaying the terminal stopped state now.";

export const SHUTDOWN_REPLAY_LIMITS = Object.freeze({
	maxBranchEntries: 50_000,
	maxRelevantEntries: 4_096,
	maxTrackedJobIds: 4_096,
	maxCandidates: 64,
	maxIdBytes: 128,
	maxNameBytes: 128,
	maxRouteFieldBytes: 512,
	maxPathBytes: 4_096,
	maxStringBytes: 64 * 1_024,
	maxArrayItems: 256,
	maxObjectKeys: 64,
	maxDepth: 8,
	maxEntryBytes: 256 * 1_024,
	maxTotalBytes: 8 * 1_024 * 1_024,
});

const CONTROL_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_NAME = /^[a-z0-9][a-z0-9_]*$/;
const SAFE_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PATH_KEYS = new Set([
	"cwd",
	"logPath",
	"contextPath",
	"contextFiles",
	"writeScope",
	"changedFiles",
]);
const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CONTEXT_MODES = new Set(["isolated", "selected", "summary", "full"]);
const PERMISSIONS = new Set(["read-only", "workspace-write"]);
const COMPLEXITIES = new Set(["simple", "medium", "complex", "critical"]);
const TERMINAL_EVENTS = new Set(["completed", "failed", "stopped"]);
const MISSING = Symbol("missing");

export interface ShutdownReplayRoute {
	modelRef: string;
	provider: string;
	modelId: string;
	modelName: string;
	providerName: string;
	effort: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
	contextMode: "isolated" | "selected" | "summary" | "full";
	permission: "read-only" | "workspace-write";
	complexity?: "simple" | "medium" | "complex" | "critical";
}

/** Privacy-minimal snapshot used only for shutdown completion recovery. */
export interface ShutdownReplayJobSnapshot {
	id: string;
	name: string;
	status: "stopped";
	route?: ShutdownReplayRoute;
	createdAt: number;
	startedAt?: number;
	finishedAt: number;
	terminationReason: "session_shutdown";
	/** Fixed extension-owned text; never copied from persisted job output/error. */
	error: typeof SHUTDOWN_REPLAY_REASON;
}

export interface ShutdownReplayScanResult {
	/** Ordered by each job's latest state entry in the active branch. */
	candidates: ShutdownReplayJobSnapshot[];
	/** Valid terminal completion messages found on that same branch. */
	deliveredIds: string[];
}

interface LatestState {
	index: number;
	candidate?: ShutdownReplayJobSnapshot;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === Object.prototype || prototype === null;
	} catch {
		return false;
	}
}

/** Read only own data properties. Accessors are not valid persisted JSON. */
function ownData(record: Record<string, unknown>, key: string): unknown | typeof MISSING {
	const descriptor = Object.getOwnPropertyDescriptor(record, key);
	return descriptor && "value" in descriptor ? descriptor.value : MISSING;
}

function utf8BytesWithin(value: string, maximum: number): number | undefined {
	// UTF-8 is never smaller than UTF-16 code-unit count, so this avoids walking
	// obviously oversized hostile strings twice.
	if (value.length > maximum) return undefined;
	const bytes = Buffer.byteLength(value, "utf8");
	return bytes <= maximum ? bytes : undefined;
}

function safeId(value: unknown): value is string {
	return typeof value === "string" &&
		utf8BytesWithin(value, SHUTDOWN_REPLAY_LIMITS.maxIdBytes) !== undefined &&
		SAFE_ID.test(value) &&
		!CONTROL_CHARACTERS.test(value);
}

function safeName(value: unknown): value is string {
	// Job names are normalized to this grammar at dispatch. Keeping recovery
	// equally strict prevents persisted display text from becoming prompt text.
	return typeof value === "string" &&
		SAFE_NAME.test(value) &&
		utf8BytesWithin(value, SHUTDOWN_REPLAY_LIMITS.maxNameBytes) !== undefined &&
		!CONTROL_CHARACTERS.test(value);
}

function safeRouteText(value: unknown, maximum = SHUTDOWN_REPLAY_LIMITS.maxRouteFieldBytes): value is string {
	return typeof value === "string" &&
		value.length > 0 &&
		value.trim() === value &&
		utf8BytesWithin(value, maximum) !== undefined &&
		!CONTROL_CHARACTERS.test(value);
}

function safeTimestamp(value: unknown): value is number {
	// Deliberately no wall-clock freshness check: persisted tests and old sessions
	// may use small, but otherwise valid, timestamps.
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validate and size every enumerable value without JSON.stringify (which can
 * throw on cycles and can invoke user-defined toJSON methods). Undefined own
 * values are tolerated because in-memory appendEntry snapshots may contain
 * fields that JSON persistence later omits.
 */
function boundedValueBytes(root: unknown): number | undefined {
	const seen = new Set<object>();
	const stack: Array<{ value: unknown; depth: number; pathLike: boolean }> = [
		{ value: root, depth: 0, pathLike: false },
	];
	let total = 0;
	let nodes = 0;

	while (stack.length > 0) {
		const item = stack.pop()!;
		nodes += 1;
		if (nodes > SHUTDOWN_REPLAY_LIMITS.maxObjectKeys * SHUTDOWN_REPLAY_LIMITS.maxArrayItems) return undefined;
		if (item.depth > SHUTDOWN_REPLAY_LIMITS.maxDepth) return undefined;
		const value = item.value;
		if (value === undefined || value === null || typeof value === "boolean") {
			total += 1;
			continue;
		}
		if (typeof value === "number") {
			if (!Number.isFinite(value)) return undefined;
			total += 24;
			continue;
		}
		if (typeof value === "string") {
			const maximum = item.pathLike
				? SHUTDOWN_REPLAY_LIMITS.maxPathBytes
				: SHUTDOWN_REPLAY_LIMITS.maxStringBytes;
			const bytes = utf8BytesWithin(value, maximum);
			if (bytes === undefined) return undefined;
			total += bytes + 2;
			if (total > SHUTDOWN_REPLAY_LIMITS.maxEntryBytes) return undefined;
			continue;
		}
		if (typeof value !== "object") return undefined;
		if (seen.has(value)) return undefined;
		seen.add(value);

		if (Array.isArray(value)) {
			if (value.length > SHUTDOWN_REPLAY_LIMITS.maxArrayItems) return undefined;
			total += 2 + value.length;
			for (let index = value.length - 1; index >= 0; index--) {
				stack.push({ value: value[index], depth: item.depth + 1, pathLike: item.pathLike });
			}
			continue;
		}
		if (!isPlainRecord(value)) return undefined;
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Object.keys(descriptors);
		if (keys.length > SHUTDOWN_REPLAY_LIMITS.maxObjectKeys) return undefined;
		total += 2 + keys.length;
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index]!;
			const descriptor = descriptors[key]!;
			if (!("value" in descriptor) || CONTROL_CHARACTERS.test(key)) return undefined;
			const keyBytes = utf8BytesWithin(key, SHUTDOWN_REPLAY_LIMITS.maxNameBytes);
			if (keyBytes === undefined) return undefined;
			total += keyBytes + 3;
			stack.push({
				value: descriptor.value,
				depth: item.depth + 1,
				pathLike: item.pathLike || PATH_KEYS.has(key),
			});
		}
		if (total > SHUTDOWN_REPLAY_LIMITS.maxEntryBytes) return undefined;
	}
	return total <= SHUTDOWN_REPLAY_LIMITS.maxEntryBytes ? total : undefined;
}

function parseRoute(value: unknown): ShutdownReplayRoute | undefined | null {
	if (value === undefined || value === MISSING) return undefined;
	if (!isPlainRecord(value)) return null;
	const modelRef = ownData(value, "modelRef");
	const provider = ownData(value, "provider");
	const modelId = ownData(value, "modelId");
	const modelName = ownData(value, "modelName");
	const providerName = ownData(value, "providerName");
	const effort = ownData(value, "effort");
	const contextMode = ownData(value, "contextMode");
	const permission = ownData(value, "permission");
	const complexity = ownData(value, "complexity");

	if (!safeRouteText(modelRef) || !safeRouteText(provider, 128) || !SAFE_PROVIDER.test(provider) ||
		!safeRouteText(modelId, 256) || !safeRouteText(modelName, 256) ||
		!safeRouteText(providerName, 256) || modelRef !== `${provider}/${modelId}` ||
		typeof effort !== "string" || !EFFORTS.has(effort) ||
		typeof contextMode !== "string" || !CONTEXT_MODES.has(contextMode) ||
		typeof permission !== "string" || !PERMISSIONS.has(permission)) {
		return null;
	}
	if (complexity !== MISSING && complexity !== undefined &&
		(typeof complexity !== "string" || !COMPLEXITIES.has(complexity))) {
		return null;
	}

	const route: ShutdownReplayRoute = {
		modelRef,
		provider,
		modelId,
		modelName,
		providerName,
		effort: effort as ShutdownReplayRoute["effort"],
		contextMode: contextMode as ShutdownReplayRoute["contextMode"],
		permission: permission as ShutdownReplayRoute["permission"],
	};
	if (typeof complexity === "string") {
		route.complexity = complexity as NonNullable<ShutdownReplayRoute["complexity"]>;
	}
	return route;
}

function parseShutdownCandidate(data: Record<string, unknown>): ShutdownReplayJobSnapshot | undefined {
	const id = ownData(data, "id");
	const name = ownData(data, "name");
	const status = ownData(data, "status");
	const terminationReason = ownData(data, "terminationReason");
	const createdAt = ownData(data, "createdAt");
	const startedAt = ownData(data, "startedAt");
	const finishedAt = ownData(data, "finishedAt");
	if (!safeId(id) || !safeName(name) || status !== "stopped" ||
		terminationReason !== "session_shutdown" || !safeTimestamp(createdAt) ||
		!safeTimestamp(finishedAt)) {
		return undefined;
	}
	if (startedAt !== MISSING && startedAt !== undefined && !safeTimestamp(startedAt)) return undefined;
	if (finishedAt < createdAt || (typeof startedAt === "number" &&
		(startedAt < createdAt || finishedAt < startedAt))) {
		return undefined;
	}
	const route = parseRoute(ownData(data, "route"));
	if (route === null) return undefined;

	const snapshot: ShutdownReplayJobSnapshot = {
		id,
		name,
		status: "stopped",
		createdAt,
		finishedAt,
		terminationReason: "session_shutdown",
		error: SHUTDOWN_REPLAY_REASON,
	};
	if (typeof startedAt === "number") snapshot.startedAt = startedAt;
	if (route) snapshot.route = route;
	return snapshot;
}

function parseCompletionAck(entry: Record<string, unknown>): string | undefined {
	const details = ownData(entry, "details");
	if (!isPlainRecord(details)) return undefined;
	const event = ownData(details, "event");
	const job = ownData(details, "job");
	if (typeof event !== "string" || !TERMINAL_EVENTS.has(event) || !isPlainRecord(job)) return undefined;
	const id = ownData(job, "id");
	const status = ownData(job, "status");
	return safeId(id) && status === event ? id : undefined;
}

/**
 * Scan only the supplied active branch, preserving branch order. A later state
 * with an identifiable job id always replaces an older one, even when the
 * later state is malformed; this prevents replaying a stale terminal record.
 */
export function scanShutdownCompletionReplay(branch: readonly unknown[]): ShutdownReplayScanResult {
	const empty: ShutdownReplayScanResult = { candidates: [], deliveredIds: [] };
	try {
		if (!Array.isArray(branch) || branch.length > SHUTDOWN_REPLAY_LIMITS.maxBranchEntries) return empty;
		const latest = new Map<string, LatestState>();
		const delivered = new Set<string>();
		let relevantEntries = 0;
		let totalBytes = 0;
		let fatal = false;

		for (let index = 0; index < branch.length; index++) {
			const rawEntry = branch[index];
			if (!isPlainRecord(rawEntry)) continue;
			const type = ownData(rawEntry, "type");
			const customType = ownData(rawEntry, "customType");
			const stateEntry = type === "custom" && customType === "smart-subagent-state";
			const completionEntry = type === "custom_message" && customType === "smart-subagent-completion";
			if (!stateEntry && !completionEntry) continue;
			relevantEntries += 1;
			if (relevantEntries > SHUTDOWN_REPLAY_LIMITS.maxRelevantEntries) {
				fatal = true;
				break;
			}

			const payload = stateEntry ? ownData(rawEntry, "data") : ownData(rawEntry, "details");
			const entryBytes = boundedValueBytes(payload);
			if (entryBytes !== undefined) {
				totalBytes += entryBytes;
				if (totalBytes > SHUTDOWN_REPLAY_LIMITS.maxTotalBytes) {
					fatal = true;
					break;
				}
			}

			if (completionEntry) {
				if (entryBytes === undefined) continue;
				const id = parseCompletionAck(rawEntry);
				if (id) delivered.add(id);
				if (delivered.size > SHUTDOWN_REPLAY_LIMITS.maxTrackedJobIds) {
					fatal = true;
					break;
				}
				continue;
			}

			if (!isPlainRecord(payload)) continue;
			const rawId = ownData(payload, "id");
			// Fail closed per identifiable job. An entry without a safe id cannot
			// be correlated with (and therefore cannot revive) any safe-id state.
			if (!safeId(rawId)) continue;
			const candidate = entryBytes === undefined ? undefined : parseShutdownCandidate(payload);
			latest.set(rawId, { index, candidate });
			if (latest.size > SHUTDOWN_REPLAY_LIMITS.maxTrackedJobIds) {
				fatal = true;
				break;
			}
		}

		const deliveredIds = [...delivered];
		if (fatal) return { candidates: [], deliveredIds };
		const candidates = [...latest.values()]
			.filter((state): state is LatestState & { candidate: ShutdownReplayJobSnapshot } => Boolean(state.candidate))
			.filter((state) => !delivered.has(state.candidate.id))
			.sort((left, right) => left.index - right.index)
			.slice(0, SHUTDOWN_REPLAY_LIMITS.maxCandidates)
			.map((state) => state.candidate);
		return { candidates, deliveredIds };
	} catch {
		return empty;
	}
}
