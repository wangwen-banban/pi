import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatRemainingPercent,
	formatResetCountdown,
	type WeeklyUsage,
	weeklyUsageFromApi,
	weeklyUsageFromHeaders,
} from "./usage.ts";

const STATUS_KEY = "codex-weekly-usage";
const REFRESH_INTERVAL_MS = 5 * 60_000;
const DISPLAY_INTERVAL_MS = 60_000;
const MIN_REFRESH_GAP_MS = 30_000;
const CACHE_STALE_MS = 30 * 60_000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const CACHE_PATH = path.join(AGENT_DIR, "cache", "codex-weekly-usage.json");

interface CodexIdentity {
	token: string;
	accountId: string;
}

function getCodexIdentity(token: string): CodexIdentity {
	const parts = token.split(".");
	if (parts.length !== 3) throw new Error("Codex bearer token is not a JWT");
	const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
	const auth = payload["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || !accountId) throw new Error("Codex account ID is missing from bearer token");
	return { token, accountId };
}

function readBearerToken(): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"pi",
			["auth", "print-bearer-token", "--provider", "openai-codex", "--min-expiry", "10m"],
			{ encoding: "utf8", timeout: 20_000, maxBuffer: 16 * 1024 },
			(error, stdout, stderr) => {
				if (error) {
					reject(new Error(stderr.trim() || error.message));
					return;
				}
				const token = stdout.trim();
				if (!token) {
					reject(new Error("pi returned an empty Codex bearer token"));
					return;
				}
				resolve(token);
			},
		);
	});
}

async function fetchWeeklyUsage(): Promise<WeeklyUsage> {
	const identity = getCodexIdentity(await readBearerToken());
	const response = await fetch(USAGE_URL, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${identity.token}`,
			"chatgpt-account-id": identity.accountId,
			"user-agent": "pi-weekly-usage-status/1.0",
		},
		signal: AbortSignal.timeout(20_000),
	});
	if (!response.ok) throw new Error(`Codex usage endpoint returned HTTP ${response.status}`);
	const usage = weeklyUsageFromApi(await response.json());
	if (!usage) throw new Error("Codex usage response did not contain a seven-day window");
	return usage;
}

function loadCache(): WeeklyUsage | undefined {
	try {
		const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8")) as WeeklyUsage;
		if (
			typeof parsed.remainingPercent !== "number" ||
			typeof parsed.usedPercent !== "number" ||
			typeof parsed.windowMinutes !== "number" ||
			typeof parsed.updatedAt !== "number"
		) {
			return undefined;
		}
		return { ...parsed, source: "cache" };
	} catch {
		return undefined;
	}
}

async function saveCache(usage: WeeklyUsage): Promise<void> {
	try {
		await fs.promises.mkdir(path.dirname(CACHE_PATH), { recursive: true, mode: 0o700 });
		await fs.promises.writeFile(CACHE_PATH, `${JSON.stringify(usage, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
		});
	} catch {
		// The status remains useful even if its non-sensitive cache cannot be persisted.
	}
}

function statusText(ctx: ExtensionContext, usage: WeeklyUsage | undefined, loading: boolean): string {
	const theme = ctx.ui.theme;
	if (!usage) return theme.fg("dim", loading ? "weekly …" : "weekly unavailable");
	const remaining = formatRemainingPercent(usage.remainingPercent);
	const countdown = formatResetCountdown(usage.resetsAt);
	const stale = Date.now() - usage.updatedAt > CACHE_STALE_MS;
	const suffix = [countdown ? `reset ${countdown}` : undefined, stale ? "cached" : undefined].filter(Boolean).join(" · ");
	const text = `weekly ${remaining}% remaining${suffix ? ` · ${suffix}` : ""}`;
	const color = usage.remainingPercent <= 10 ? "error" : usage.remainingPercent <= 25 ? "warning" : "success";
	return theme.fg(color, text);
}

export default function weeklyUsageStatus(pi: ExtensionAPI) {
	let usage: WeeklyUsage | undefined = loadCache();
	let currentContext: ExtensionContext | undefined;
	let refreshPromise: Promise<WeeklyUsage | undefined> | undefined;
	let lastRefreshStartedAt = 0;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let displayTimer: ReturnType<typeof setInterval> | undefined;
	let active = true;

	const render = (loading = false) => {
		const ctx = currentContext;
		if (!ctx || ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS_KEY, statusText(ctx, usage, loading));
	};

	const acceptUsage = (next: WeeklyUsage) => {
		usage = next;
		render();
		void saveCache(next);
	};

	const refresh = async (force = false): Promise<WeeklyUsage | undefined> => {
		if (!active || !currentContext || currentContext.mode !== "tui") return usage;
		if (refreshPromise) return refreshPromise;
		if (!force && Date.now() - lastRefreshStartedAt < MIN_REFRESH_GAP_MS) return usage;
		lastRefreshStartedAt = Date.now();
		render(!usage);
		refreshPromise = fetchWeeklyUsage()
			.then((next) => {
				if (active) acceptUsage(next);
				return next;
			})
			.catch(() => {
				if (active) render();
				return undefined;
			})
			.finally(() => {
				refreshPromise = undefined;
			});
		return refreshPromise;
	};

	const stopTimers = () => {
		if (refreshTimer) clearInterval(refreshTimer);
		if (displayTimer) clearInterval(displayTimer);
		refreshTimer = undefined;
		displayTimer = undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		active = true;
		stopTimers();
		if (ctx.mode !== "tui") return;
		render(!usage);
		void refresh(true);
		refreshTimer = setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
		displayTimer = setInterval(() => render(), DISPLAY_INTERVAL_MS);
		refreshTimer.unref?.();
		displayTimer.unref?.();
	});

	pi.on("after_provider_response", (event, ctx) => {
		currentContext = ctx;
		const headerUsage = weeklyUsageFromHeaders(event.headers);
		if (headerUsage) acceptUsage(headerUsage);
	});

	pi.on("turn_end", (_event, ctx) => {
		currentContext = ctx;
		void refresh();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		active = false;
		stopTimers();
		if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
		currentContext = undefined;
	});

	pi.registerCommand("weekly", {
		description: "Refresh and show remaining Codex weekly quota",
		handler: async (_args, ctx) => {
			currentContext = ctx;
			const next = await refresh(true);
			if (!next) {
				ctx.ui.notify("Unable to refresh Codex weekly quota; showing the last cached value.", "warning");
				return;
			}
			const remaining = formatRemainingPercent(next.remainingPercent);
			const reset = formatResetCountdown(next.resetsAt);
			ctx.ui.notify(`Codex weekly: ${remaining}% remaining${reset ? `; resets in ${reset}` : ""}.`, "info");
		},
	});
}
