import { parseTerminalBackgroundRunSnapshot } from "./run-persistence.ts";
import type { BackgroundRunSnapshot } from "./runner.ts";

export const BACKGROUND_WAKE_MARKER_TYPE = "background-task-wake-v1";
export const BACKGROUND_WAKE_VERSION = 1;

export interface BackgroundWakeMarker {
	version: typeof BACKGROUND_WAKE_VERSION;
	runId: string;
	state: "pending" | "acknowledged";
	updatedAt: number;
	run?: BackgroundRunSnapshot;
}

export interface BackgroundWakeBranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
	details?: unknown;
	message?: unknown;
}

export interface ReconstructedWakeOutbox {
	pending: Map<string, BackgroundRunSnapshot>;
	knownRunIds: Set<string>;
	implicitlyAcknowledged: Set<string>;
}

const SAFE_RUN_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function pendingWakeMarker(run: BackgroundRunSnapshot, now = Date.now()): BackgroundWakeMarker {
	if (run.status === "running") throw new Error(`cannot queue wake for running task ${run.id}`);
	return {
		version: BACKGROUND_WAKE_VERSION,
		runId: run.id,
		state: "pending",
		updatedAt: now,
		run: { ...run },
	};
}

export function acknowledgedWakeMarker(runId: string, now = Date.now()): BackgroundWakeMarker {
	if (!SAFE_RUN_ID.test(runId)) throw new Error(`invalid background wake run id: ${runId}`);
	return {
		version: BACKGROUND_WAKE_VERSION,
		runId,
		state: "acknowledged",
		updatedAt: now,
	};
}

export function parseBackgroundWakeMarker(value: unknown): BackgroundWakeMarker | undefined {
	if (!isRecord(value) || value.version !== BACKGROUND_WAKE_VERSION) return undefined;
	if (typeof value.runId !== "string" || !SAFE_RUN_ID.test(value.runId)) return undefined;
	if (value.state !== "pending" && value.state !== "acknowledged") return undefined;
	if (typeof value.updatedAt !== "number" || !Number.isFinite(value.updatedAt)) return undefined;
	if (value.state === "acknowledged") {
		return { version: BACKGROUND_WAKE_VERSION, runId: value.runId, state: "acknowledged", updatedAt: value.updatedAt };
	}
	const run = parseTerminalBackgroundRunSnapshot(value.run);
	if (!run || run.id !== value.runId) return undefined;
	return { version: BACKGROUND_WAKE_VERSION, runId: value.runId, state: "pending", updatedAt: value.updatedAt, run };
}

function completionRunIds(entry: BackgroundWakeBranchEntry): string[] {
	if (entry.type !== "custom_message" || entry.customType !== "background-task-completion") return [];
	const details = isRecord(entry.details) ? entry.details : undefined;
	if (!details) return [];
	const ids = new Set<string>();
	if (Array.isArray(details.wakeRunIds)) {
		for (const id of details.wakeRunIds) if (typeof id === "string" && SAFE_RUN_ID.test(id)) ids.add(id);
	}
	if (Array.isArray(details.runs)) {
		for (const run of details.runs) {
			if (isRecord(run) && typeof run.id === "string" && SAFE_RUN_ID.test(run.id)) ids.add(run.id);
		}
	}
	return [...ids];
}

function isSuccessfulAssistant(entry: BackgroundWakeBranchEntry): boolean {
	if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "assistant") return false;
	return entry.message.stopReason !== "error" && entry.message.stopReason !== "aborted";
}

/**
 * Rebuild the append-only completion outbox on the active branch. A persisted
 * successful assistant response after a completion message is an implicit ack
 * for the tiny crash window before the explicit ack marker is appended.
 */
export function reconstructWakeOutbox(entries: BackgroundWakeBranchEntry[]): ReconstructedWakeOutbox {
	const pending = new Map<string, BackgroundRunSnapshot>();
	const knownRunIds = new Set<string>();
	const implicitlyAcknowledged = new Set<string>();
	const dispatched = new Set<string>();

	for (const entry of entries) {
		if (entry?.type === "custom" && entry.customType === BACKGROUND_WAKE_MARKER_TYPE) {
			const marker = parseBackgroundWakeMarker(entry.data);
			if (!marker) continue;
			knownRunIds.add(marker.runId);
			dispatched.delete(marker.runId);
			implicitlyAcknowledged.delete(marker.runId);
			if (marker.state === "pending" && marker.run) pending.set(marker.runId, marker.run);
			else pending.delete(marker.runId);
			continue;
		}

		for (const runId of completionRunIds(entry)) {
			if (pending.has(runId)) dispatched.add(runId);
		}
		if (!isSuccessfulAssistant(entry) || dispatched.size === 0) continue;
		for (const runId of dispatched) {
			if (!pending.has(runId)) continue;
			pending.delete(runId);
			implicitlyAcknowledged.add(runId);
		}
		dispatched.clear();
	}

	return { pending, knownRunIds, implicitlyAcknowledged };
}
