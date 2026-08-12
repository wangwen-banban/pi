export interface WeeklyUsage {
	usedPercent: number;
	remainingPercent: number;
	windowMinutes: number;
	resetsAt?: number;
	updatedAt: number;
	source: "api" | "headers" | "cache";
}

interface WindowCandidate {
	usedPercent: number;
	windowMinutes: number;
	resetsAt?: number;
	priority: number;
}

const WEEK_MINUTES = 7 * 24 * 60;
const WEEK_TOLERANCE_MINUTES = 24 * 60;

function finiteNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function normalizeEpochSeconds(value: unknown): number | undefined {
	const parsed = finiteNumber(value);
	if (parsed === undefined || parsed <= 0) return undefined;
	return parsed > 10_000_000_000 ? Math.round(parsed / 1000) : Math.round(parsed);
}

function selectWeeklyCandidate(candidates: WindowCandidate[], source: WeeklyUsage["source"]): WeeklyUsage | undefined {
	const weekly = candidates
		.filter(
			(candidate) =>
				candidate.windowMinutes >= WEEK_MINUTES - WEEK_TOLERANCE_MINUTES &&
				candidate.windowMinutes <= WEEK_MINUTES + WEEK_TOLERANCE_MINUTES,
		)
		.sort((a, b) => {
			const priority = a.priority - b.priority;
			if (priority !== 0) return priority;
			return Math.abs(a.windowMinutes - WEEK_MINUTES) - Math.abs(b.windowMinutes - WEEK_MINUTES);
		})[0];
	if (!weekly) return undefined;
	const usedPercent = Math.min(100, Math.max(0, weekly.usedPercent));
	return {
		usedPercent,
		remainingPercent: Math.min(100, Math.max(0, 100 - usedPercent)),
		windowMinutes: weekly.windowMinutes,
		resetsAt: weekly.resetsAt,
		updatedAt: Date.now(),
		source,
	};
}

function collectApiWindows(value: unknown, candidates: WindowCandidate[], path: string[] = [], depth = 0): void {
	if (!value || typeof value !== "object" || depth > 8) return;
	if (Array.isArray(value)) {
		for (const item of value) collectApiWindows(item, candidates, path, depth + 1);
		return;
	}

	const record = value as Record<string, unknown>;
	const usedPercent = finiteNumber(record.used_percent);
	const windowSeconds = finiteNumber(record.limit_window_seconds);
	const windowMinutes = finiteNumber(record.window_minutes) ?? (windowSeconds === undefined ? undefined : windowSeconds / 60);
	if (usedPercent !== undefined && windowMinutes !== undefined && windowMinutes > 0) {
		const directReset = normalizeEpochSeconds(record.reset_at ?? record.resets_at);
		const resetAfterSeconds = finiteNumber(record.reset_after_seconds);
		const resetsAt = directReset ?? (resetAfterSeconds === undefined ? undefined : Math.round(Date.now() / 1000 + resetAfterSeconds));
		const isPrimaryCodexLimit = path[0] === "rate_limit" ? 0 : 1;
		candidates.push({ usedPercent, windowMinutes, resetsAt, priority: isPrimaryCodexLimit });
	}

	for (const [key, child] of Object.entries(record)) {
		collectApiWindows(child, candidates, [...path, key], depth + 1);
	}
}

export function weeklyUsageFromApi(payload: unknown): WeeklyUsage | undefined {
	const candidates: WindowCandidate[] = [];
	collectApiWindows(payload, candidates);
	return selectWeeklyCandidate(candidates, "api");
}

export function weeklyUsageFromHeaders(rawHeaders: Record<string, string>): WeeklyUsage | undefined {
	const headers = new Map(Object.entries(rawHeaders).map(([key, value]) => [key.toLowerCase(), value]));
	const candidates: WindowCandidate[] = [];
	for (const [name, rawUsed] of headers) {
		const match = /^(x-[a-z0-9-]+)-(primary|secondary)-used-percent$/.exec(name);
		if (!match) continue;
		const usedPercent = finiteNumber(rawUsed);
		const windowMinutes = finiteNumber(headers.get(`${match[1]}-${match[2]}-window-minutes`));
		if (usedPercent === undefined || windowMinutes === undefined || windowMinutes <= 0) continue;
		const resetsAt = normalizeEpochSeconds(headers.get(`${match[1]}-${match[2]}-reset-at`));
		candidates.push({
			usedPercent,
			windowMinutes,
			resetsAt,
			priority: match[1] === "x-codex" ? 0 : 1,
		});
	}
	return selectWeeklyCandidate(candidates, "headers");
}

export function formatRemainingPercent(percent: number): string {
	const rounded = Math.round(percent * 10) / 10;
	return Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
}

export function formatResetCountdown(resetsAt: number | undefined, nowMs = Date.now()): string | undefined {
	if (!resetsAt) return undefined;
	const remainingSeconds = Math.max(0, resetsAt - Math.floor(nowMs / 1000));
	if (remainingSeconds === 0) return "now";
	const days = Math.floor(remainingSeconds / 86_400);
	const hours = Math.floor((remainingSeconds % 86_400) / 3_600);
	const minutes = Math.floor((remainingSeconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${Math.max(1, minutes)}m`;
}
