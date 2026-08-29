import {
	MAX_TERMINAL_MANIFEST_AGE_MS,
	MAX_TERMINAL_MANIFEST_FUTURE_SKEW_MS,
	SAFE_RUN_ID,
	SAFE_SESSION_ID,
	parseTerminalRunManifest,
	type TerminalRunManifest,
} from "./run-persistence.ts";

export const BACKGROUND_WAKE_MARKER_TYPE = "background-task-wake-v2";
export const BACKGROUND_WAKE_VERSION = 2;
const SAFE_DELIVERY_ID = /^wake-[a-f0-9]{32,96}$/;
const MAX_WAKE_ITEMS = 50;

export interface WakeDeliveryItem {
	runId: string;
	sequence: number;
}

export interface PendingBackgroundWakeMarker {
	version: typeof BACKGROUND_WAKE_VERSION;
	kind: "pending";
	sessionId: string;
	runId: string;
	sequence: number;
	updatedAt: number;
	terminal: TerminalRunManifest;
}

export interface DeliveryBackgroundWakeMarker {
	version: typeof BACKGROUND_WAKE_VERSION;
	kind: "delivery";
	sessionId: string;
	deliveryId: string;
	attempt: number;
	updatedAt: number;
	items: WakeDeliveryItem[];
}

export interface AcknowledgedBackgroundWakeMarker {
	version: typeof BACKGROUND_WAKE_VERSION;
	kind: "acknowledged";
	sessionId: string;
	deliveryId: string;
	attempt: number;
	updatedAt: number;
	items: WakeDeliveryItem[];
}

export type BackgroundWakeMarker =
	| PendingBackgroundWakeMarker
	| DeliveryBackgroundWakeMarker
	| AcknowledgedBackgroundWakeMarker;

export interface BackgroundWakeBranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

export interface ReconstructedPendingWake {
	sequence: number;
	updatedAt: number;
	terminal: TerminalRunManifest;
}

export interface ReconstructedWakeOutbox {
	pending: Map<string, ReconstructedPendingWake>;
	acknowledged: Map<string, TerminalRunManifest>;
	knownRunIds: Set<string>;
	nextSequence: number;
	maxAttempt: number;
	invalidMarkerCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function positiveInteger(value: unknown): value is number {
	// Sequence/attempt allocators add one after reconstruction, so reserve the
	// largest safe integer rather than restoring an immediately unusable state.
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
}

function validMarkerTime(value: unknown, now: number): value is number {
	return typeof value === "number"
		&& Number.isSafeInteger(value)
		&& value >= 0
		&& value <= now + MAX_TERMINAL_MANIFEST_FUTURE_SKEW_MS
		&& now - value <= MAX_TERMINAL_MANIFEST_AGE_MS;
}

function normalizeItems(items: Iterable<WakeDeliveryItem>): WakeDeliveryItem[] {
	const result = [...items].map((item) => ({ runId: item.runId, sequence: item.sequence }));
	if (result.length === 0 || result.length > MAX_WAKE_ITEMS) throw new Error("wake delivery item count is invalid");
	const ids = new Set<string>();
	for (const item of result) {
		if (!SAFE_RUN_ID.test(item.runId) || !positiveInteger(item.sequence) || ids.has(item.runId)) {
			throw new Error("wake delivery identity is invalid");
		}
		ids.add(item.runId);
	}
	return result.sort((a, b) => a.runId.localeCompare(b.runId) || a.sequence - b.sequence);
}

function parseItems(value: unknown): WakeDeliveryItem[] | undefined {
	if (!Array.isArray(value)) return undefined;
	try {
		const items = normalizeItems(value.map((item) => {
			if (!isRecord(item) || !exactKeys(item, ["runId", "sequence"])) throw new Error("invalid wake item");
			return { runId: item.runId as string, sequence: item.sequence as number };
		}));
		return items;
	} catch {
		return undefined;
	}
}

export function pendingWakeMarker(
	terminal: TerminalRunManifest,
	sequence: number,
	now = Date.now(),
): PendingBackgroundWakeMarker {
	if (!positiveInteger(sequence)) throw new Error("invalid wake sequence");
	const parsed = parseTerminalRunManifest(terminal, {
		sessionId: terminal.sessionId,
		runId: terminal.runId,
		taskId: terminal.taskId,
		now,
	});
	if (!parsed.ok) throw new Error("invalid terminal wake record");
	return {
		version: BACKGROUND_WAKE_VERSION,
		kind: "pending",
		sessionId: terminal.sessionId,
		runId: terminal.runId,
		sequence,
		updatedAt: Math.round(now),
		terminal: { ...terminal },
	};
}

export function deliveryWakeMarker(
	sessionId: string,
	deliveryId: string,
	attempt: number,
	items: Iterable<WakeDeliveryItem>,
	now = Date.now(),
): DeliveryBackgroundWakeMarker {
	if (!SAFE_SESSION_ID.test(sessionId) || !SAFE_DELIVERY_ID.test(deliveryId) || !positiveInteger(attempt)) {
		throw new Error("invalid wake delivery identity");
	}
	return {
		version: BACKGROUND_WAKE_VERSION,
		kind: "delivery",
		sessionId,
		deliveryId,
		attempt,
		updatedAt: Math.round(now),
		items: normalizeItems(items),
	};
}

export function acknowledgedWakeMarker(
	delivery: DeliveryBackgroundWakeMarker,
	now = Date.now(),
): AcknowledgedBackgroundWakeMarker {
	return {
		version: BACKGROUND_WAKE_VERSION,
		kind: "acknowledged",
		sessionId: delivery.sessionId,
		deliveryId: delivery.deliveryId,
		attempt: delivery.attempt,
		updatedAt: Math.round(now),
		items: normalizeItems(delivery.items),
	};
}

export function parseBackgroundWakeMarker(
	value: unknown,
	expectedSessionId: string,
	now = Date.now(),
): BackgroundWakeMarker | undefined {
	if (!SAFE_SESSION_ID.test(expectedSessionId) || !isRecord(value) || value.version !== BACKGROUND_WAKE_VERSION) return undefined;
	if (value.sessionId !== expectedSessionId || !validMarkerTime(value.updatedAt, now)) return undefined;
	if (value.kind === "pending") {
		if (!exactKeys(value, ["version", "kind", "sessionId", "runId", "sequence", "updatedAt", "terminal"])) return undefined;
		if (typeof value.runId !== "string" || !SAFE_RUN_ID.test(value.runId) || !positiveInteger(value.sequence)) return undefined;
		if (!isRecord(value.terminal) || typeof value.terminal.taskId !== "string") return undefined;
		const parsed = parseTerminalRunManifest(value.terminal, {
			sessionId: expectedSessionId,
			runId: value.runId,
			taskId: value.terminal.taskId,
			now,
		});
		if (!parsed.ok || (value.updatedAt as number) < parsed.manifest.finishedAt) return undefined;
		return {
			version: BACKGROUND_WAKE_VERSION,
			kind: "pending",
			sessionId: expectedSessionId,
			runId: value.runId,
			sequence: value.sequence,
			updatedAt: value.updatedAt as number,
			terminal: parsed.manifest,
		};
	}
	if (value.kind !== "delivery" && value.kind !== "acknowledged") return undefined;
	if (!exactKeys(value, ["version", "kind", "sessionId", "deliveryId", "attempt", "updatedAt", "items"])) return undefined;
	if (typeof value.deliveryId !== "string" || !SAFE_DELIVERY_ID.test(value.deliveryId) || !positiveInteger(value.attempt)) return undefined;
	const items = parseItems(value.items);
	if (!items) return undefined;
	return {
		version: BACKGROUND_WAKE_VERSION,
		kind: value.kind,
		sessionId: expectedSessionId,
		deliveryId: value.deliveryId,
		attempt: value.attempt,
		updatedAt: value.updatedAt as number,
		items,
	};
}

function sameItems(left: WakeDeliveryItem[], right: WakeDeliveryItem[]): boolean {
	return left.length === right.length && left.every((item, index) => (
		item.runId === right[index]?.runId && item.sequence === right[index]?.sequence
	));
}

/** Rebuild only from explicit v2 markers. Branch order is the state-machine order. */
export function reconstructWakeOutbox(
	entries: BackgroundWakeBranchEntry[],
	sessionId: string,
	now = Date.now(),
): ReconstructedWakeOutbox {
	const pending = new Map<string, ReconstructedPendingWake>();
	const acknowledged = new Map<string, TerminalRunManifest>();
	const knownRunIds = new Set<string>();
	const deliveries = new Map<string, { marker: DeliveryBackgroundWakeMarker; acknowledged: boolean }>();
	const seenDeliveryIds = new Set<string>();
	let highestSequence = 0;
	let nextSequence = 1;
	let maxAttempt = 0;
	let invalidMarkerCount = 0;

	for (const entry of entries) {
		if (entry?.type !== "custom" || entry.customType !== BACKGROUND_WAKE_MARKER_TYPE) continue;
		const marker = parseBackgroundWakeMarker(entry.data, sessionId, now);
		if (!marker) {
			invalidMarkerCount += 1;
			continue;
		}

		if (marker.kind === "pending") {
			nextSequence = Math.max(nextSequence, marker.sequence + 1);
			if (marker.sequence <= highestSequence) {
				invalidMarkerCount += 1;
				continue;
			}
			highestSequence = marker.sequence;
			knownRunIds.add(marker.runId);
			acknowledged.delete(marker.runId);
			pending.set(marker.runId, {
				sequence: marker.sequence,
				updatedAt: marker.updatedAt,
				terminal: marker.terminal,
			});
			continue;
		}

		const priorMaxAttempt = maxAttempt;
		maxAttempt = Math.max(maxAttempt, marker.attempt);
		if (marker.kind === "delivery") {
			const duplicateId = seenDeliveryIds.has(marker.deliveryId);
			seenDeliveryIds.add(marker.deliveryId);
			const matchesPending = marker.items.every((item) => pending.get(item.runId)?.sequence === item.sequence);
			if (duplicateId || marker.attempt <= priorMaxAttempt || !matchesPending) {
				invalidMarkerCount += 1;
				continue;
			}
			deliveries.set(marker.deliveryId, { marker, acknowledged: false });
			continue;
		}

		const delivery = deliveries.get(marker.deliveryId);
		if (!delivery) seenDeliveryIds.add(marker.deliveryId);
		const matchesCurrentPending = marker.items.every((item) => pending.get(item.runId)?.sequence === item.sequence);
		if (!delivery
			|| delivery.acknowledged
			|| marker.attempt < priorMaxAttempt
			|| delivery.marker.attempt !== marker.attempt
			|| !sameItems(delivery.marker.items, marker.items)
			|| !matchesCurrentPending) {
			invalidMarkerCount += 1;
			continue;
		}

		delivery.acknowledged = true;
		for (const item of marker.items) {
			const current = pending.get(item.runId)!;
			pending.delete(item.runId);
			acknowledged.set(item.runId, current.terminal);
		}
	}

	return { pending, acknowledged, knownRunIds, nextSequence, maxAttempt, invalidMarkerCount };
}
