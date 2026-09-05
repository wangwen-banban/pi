/**
 * Provider capacity registry for the custom status line.
 *
 * Only providers with an official quota/usage endpoint are listed. The two
 * Cambricon routes share one NewAPI account and therefore intentionally read
 * the same cache instead of showing two independent balances.
 *
 * OpenCode Go (`opencode-go`) is also absent: opencode does not expose an
 * official usage/balance API (anomalyco/opencode#31084 was closed without an
 * implementation, and the docs confirm the API-key surface exposes no
 * spend/balance data). Add it here with its own cache reader once
 * `GET /zen/go/v1/usage` (or equivalent) ships — no dashboard scraping by
 * design.
 */

import { readFileSync } from "node:fs";
import { getCodexCachePath } from "../weekly-usage-status/codex-provider.ts";
import { getNewApiCachePath } from "../newapi-usage-status/cache.ts";

export interface SubscriptionQuota {
	remaining: number | null;
	unlimited?: boolean;
	/** Unix timestamp in seconds. */
	resetsAt?: number;
	deadlineLabel?: "RESET" | "EXPIRES";
	updatedAt?: number;
}

export interface SubscriptionProvider {
	label: string;
	kind?: "codex" | "newapi";
	cacheFile: (agentDir: string) => string;
}

export const SUBSCRIPTION_PROVIDERS: Record<string, SubscriptionProvider> = {
	// Both Codex accounts share the same label; the rendered balance follows
	// whichever account is active (each reads its own cache file).
	"openai-codex": {
		label: "CODEX WEEK",
		cacheFile: (agentDir) => getCodexCachePath(agentDir, "openai-codex"),
	},
	"openai-codex-second": {
		label: "CODEX WEEK",
		cacheFile: (agentDir) => getCodexCachePath(agentDir, "openai-codex-second"),
	},
	"cambricon-codex": {
		label: "NEW API",
		kind: "newapi",
		cacheFile: (agentDir) => getNewApiCachePath(agentDir),
	},
	"claude-cambricon": {
		label: "NEW API",
		kind: "newapi",
		cacheFile: (agentDir) => getNewApiCachePath(agentDir),
	},
};

/**
 * Read the cached quota for a provider.
 *
 * Returns `undefined` when the provider is not a subscription provider (the
 * status line must not render a quota bar for it), and `{ remaining: null }`
 * when it is a subscription provider but no usable cache exists yet.
 */
export function readSubscriptionQuota(agentDir: string, provider: unknown): SubscriptionQuota | undefined {
	const entry = SUBSCRIPTION_PROVIDERS[String(provider)];
	if (!entry) return undefined;
	try {
		const data = JSON.parse(readFileSync(entry.cacheFile(agentDir), "utf8")) as {
			version?: unknown;
			account?: unknown;
			remainingPercent?: unknown;
			resetsAt?: unknown;
			expiresAt?: unknown;
			unlimited?: unknown;
			updatedAt?: unknown;
		};
		if (entry.kind === "newapi") {
			if (data.version !== 1 || data.account !== "newapi-cambricon" || typeof data.unlimited !== "boolean") return { remaining: null };
			return {
				remaining: data.unlimited
					? null
					: typeof data.remainingPercent === "number" && Number.isFinite(data.remainingPercent)
						? Math.max(0, Math.min(100, data.remainingPercent))
						: null,
				unlimited: data.unlimited,
				resetsAt: typeof data.expiresAt === "number" && Number.isFinite(data.expiresAt) ? data.expiresAt : undefined,
				deadlineLabel: "EXPIRES",
				updatedAt: typeof data.updatedAt === "number" && Number.isFinite(data.updatedAt) ? data.updatedAt : undefined,
			};
		}
		return {
			remaining: typeof data.remainingPercent === "number" && Number.isFinite(data.remainingPercent)
				? Math.max(0, Math.min(100, data.remainingPercent))
				: null,
			resetsAt: typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt)
				? data.resetsAt
				: undefined,
			deadlineLabel: "RESET",
		};
	} catch {
		return { remaining: null };
	}
}

export function formatResetCountdown(resetsAt: number | undefined, nowMs = Date.now()): string | null {
	if (!resetsAt) return null;
	const seconds = Math.max(0, Math.floor(resetsAt - nowMs / 1000));
	if (seconds === 0) return "now";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days > 0) return `${days}d ${hours}h`;
	if (hours > 0) return `${hours}h ${minutes}m`;
	return `${Math.max(1, minutes)}m`;
}
