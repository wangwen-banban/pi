import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readNewApiCache, writeNewApiCache } from "./cache.ts";
import {
	getNewApiProviderId,
	NEWAPI_PROVIDER_IDS,
	requestNewApiUsage,
	selectSharedNewApiKey,
	sharedNewApiRoot,
	type NewApiProviderId,
	type NewApiUsage,
} from "./usage.ts";

const STATUS_KEY = "newapi-usage";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const DISPLAY_INTERVAL_MS = 60_000;
const MIN_REFRESH_GAP_MS = 30_000;
const CACHE_STALE_MS = 30 * 60_000;
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const ROUTING_PATH = path.join(AGENT_DIR, "provider-routing.json");

function formatCountdown(epochSeconds: number | undefined, now = Date.now()): string | undefined {
	if (!epochSeconds) return undefined;
	const seconds = Math.max(0, Math.floor(epochSeconds - now / 1000));
	if (seconds === 0) return "now";
	const days = Math.floor(seconds / 86_400);
	const hours = Math.floor((seconds % 86_400) / 3_600);
	const minutes = Math.floor((seconds % 3_600) / 60);
	if (days) return `${days}d ${hours}h`;
	if (hours) return `${hours}h ${minutes}m`;
	return `${Math.max(1, minutes)}m`;
}

function formatAmount(value: number | null): string {
	if (value === null) return "N/A";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return `${Math.round(value)}`;
}

async function sharedApiKey(ctx: ExtensionContext): Promise<string> {
	const values = await Promise.all(NEWAPI_PROVIDER_IDS.map(async (provider) => {
		try {
			return await ctx.modelRegistry.getApiKeyForProvider(provider);
		} catch {
			return undefined;
		}
	}));
	const selected = selectSharedNewApiKey(values[0], values[1]);
	if (!selected) throw new Error(values.some(Boolean) ? "NewAPI provider credentials do not match" : "NewAPI credential is unavailable");
	return selected;
}

function readSharedRoot(): string {
	const payload = JSON.parse(fs.readFileSync(ROUTING_PATH, "utf8")) as { providers?: unknown };
	const root = sharedNewApiRoot(payload.providers);
	if (!root) throw new Error("NewAPI provider routes do not share one safe host");
	return root;
}

function statusText(ctx: ExtensionContext, usage: NewApiUsage | undefined, loading: boolean): string {
	if (!usage) return ctx.ui.theme.fg("dim", loading ? "newapi …" : "newapi unavailable");
	const stale = Date.now() - usage.updatedAt > CACHE_STALE_MS;
	const expiry = formatCountdown(usage.expiresAt);
	const suffix = [expiry ? `expires ${expiry}` : undefined, stale ? "cached" : undefined].filter(Boolean).join(" · ");
	const value = usage.unlimited ? "∞" : `${Math.round(usage.remainingPercent ?? 0)}% remaining`;
	const color = usage.unlimited || (usage.remainingPercent ?? 0) > 25
		? "success"
		: (usage.remainingPercent ?? 0) <= 10 ? "error" : "warning";
	return ctx.ui.theme.fg(color, `newapi ${value}${suffix ? ` · ${suffix}` : ""}`);
}

export default function newApiUsageStatus(pi: ExtensionAPI) {
	let currentProvider: NewApiProviderId | undefined;
	let currentContext: ExtensionContext | undefined;
	let usage = readNewApiCache(AGENT_DIR);
	let active = false;
	let generation = 0;
	let lastRefreshStartedAt = 0;
	let refreshPromise: Promise<NewApiUsage | undefined> | undefined;
	let requestController: AbortController | undefined;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let displayTimer: ReturnType<typeof setInterval> | undefined;

	const render = (loading = false) => {
		const ctx = currentContext;
		if (!ctx || ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, currentProvider ? statusText(ctx, usage, loading) : undefined);
	};

	const clearTimers = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (displayTimer) clearInterval(displayTimer);
		refreshTimer = undefined;
		displayTimer = undefined;
	};

	const startTimers = () => {
		if (!refreshTimer) {
			refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
			refreshTimer.unref?.();
		}
		if (!displayTimer) {
			displayTimer = setInterval(() => render(), DISPLAY_INTERVAL_MS);
			displayTimer.unref?.();
		}
	};

	const refresh = async (force = false): Promise<NewApiUsage | undefined> => {
		const ctx = currentContext;
		if (!active || !ctx || ctx.mode !== "tui" || !currentProvider) return usage;
		if (refreshPromise) return refreshPromise;
		if (!force && Date.now() - lastRefreshStartedAt < MIN_REFRESH_GAP_MS) return usage;
		lastRefreshStartedAt = Date.now();
		const requestGeneration = generation;
		render(!usage);
		requestController = new AbortController();
		let promise: Promise<NewApiUsage | undefined>;
		promise = Promise.all([Promise.resolve(readSharedRoot()), sharedApiKey(ctx)])
			.then(([root, key]) => requestNewApiUsage(root, key, { signal: requestController?.signal }))
			.then((next) => {
				if (!active || requestGeneration !== generation) return usage;
				usage = next;
				try { writeNewApiCache(next, AGENT_DIR); } catch { /* live status remains usable */ }
				render();
				return next;
			})
			.catch(() => {
				if (active && requestGeneration === generation) render();
				return undefined;
			})
			.finally(() => {
				if (refreshPromise === promise) refreshPromise = undefined;
				requestController = undefined;
			});
		refreshPromise = promise;
		return promise;
	};

	const selectProvider = (provider: unknown, ctx: ExtensionContext, force = false) => {
		currentContext = ctx;
		const previous = currentProvider;
		const next = getNewApiProviderId(provider);
		if (Boolean(previous) !== Boolean(next)) {
			generation += 1;
			requestController?.abort();
			requestController = undefined;
			refreshPromise = undefined;
		}
		currentProvider = next;
		if (ctx.mode !== "tui") return;
		if (!currentProvider) {
			clearTimers();
			render();
			return;
		}
		render(!usage);
		void refresh(force && previous === undefined);
		startTimers();
	};

	pi.on("session_start", (_event, ctx) => {
		generation += 1;
		active = true;
		clearTimers();
		requestController?.abort();
		requestController = undefined;
		refreshPromise = undefined;
		usage = readNewApiCache(AGENT_DIR) ?? usage;
		selectProvider(ctx.model?.provider, ctx, true);
	});

	pi.on("model_select", (event, ctx) => {
		selectProvider(event?.model?.provider ?? ctx.model?.provider, ctx);
	});

	pi.on("turn_end", (_event, ctx) => {
		currentContext = ctx;
		void refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		generation += 1;
		clearTimers();
		requestController?.abort();
		requestController = undefined;
		refreshPromise = undefined;
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
		currentContext = undefined;
		currentProvider = undefined;
	});

	pi.registerCommand("newapi", {
		description: "Refresh and show the shared Cambricon NewAPI quota",
		handler: async (_args, ctx) => {
			currentContext = ctx;
			currentProvider = getNewApiProviderId(ctx.model?.provider) ?? currentProvider;
			if (ctx.mode !== "tui" || !currentProvider) {
				ctx.ui.notify("Select cambricon-codex or claude-cambricon to query the shared NewAPI quota.", "warning");
				return;
			}
			const next = await refresh(true);
			if (!next) {
				ctx.ui.notify("Unable to refresh NewAPI quota; the last valid cache was preserved.", "warning");
				return;
			}
			const expiry = formatCountdown(next.expiresAt);
			const summary = next.unlimited
				? "unlimited"
				: `${Math.round(next.remainingPercent ?? 0)}% remaining (${formatAmount(next.totalAvailable)}/${formatAmount(next.totalGranted)})`;
			ctx.ui.notify(`NewAPI: ${summary}${expiry ? `; expires in ${expiry}` : ""}.`, "info");
		},
	});
}
