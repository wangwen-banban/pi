/**
 * Subscription-provider quota registry for the custom status line.
 *
 * Only providers listed here render a quota bar. Third-party API / pay-per-use
 * providers (e.g. claude-relay, big-data-claude) are intentionally absent and
 * never show quota.
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

export interface SubscriptionQuota {
	remaining: number | null;
	/** Unix timestamp in seconds. */
	resetsAt?: number;
}

export interface SubscriptionProvider {
	label: string;
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
			remainingPercent?: unknown;
			resetsAt?: unknown;
		};
		return {
			remaining: typeof data.remainingPercent === "number" && Number.isFinite(data.remainingPercent)
				? Math.max(0, Math.min(100, data.remainingPercent))
				: null,
			resetsAt: typeof data.resetsAt === "number" && Number.isFinite(data.resetsAt)
				? data.resetsAt
				: undefined,
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
