/**
 * Custom Status Line Extension
 *
 * Replaces the default footer with a more visually appealing status line
 * featuring progress bars, provider/model info, and token usage.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODEX_FAST_EVENT } from "../provider-routing/fast-mode.ts";
import { createActiveModelState, createStatuslineFlagState, getRoutingProviderForStatusline } from "./model-state.ts";
import { formatResetCountdown, readSubscriptionQuota, SUBSCRIPTION_PROVIDERS } from "./quota.ts";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const ROUTING_PATH = join(AGENT_DIR, "provider-routing.json");

function readProxyMode(provider: string): string {
	try {
		const data = JSON.parse(readFileSync(ROUTING_PATH, "utf8")) as { providers?: Record<string, { mode?: string; proxyUrl?: string }> };
		const entry = data.providers?.[getRoutingProviderForStatusline(provider)];
		if (!entry) return "direct";
		if (entry.mode === "proxy") return `proxy:${entry.proxyUrl ?? "?"}`.replace(/^proxy:http:\/\//, "proxy:");
		return entry.mode ?? "direct";
	} catch {
		return "?";
	}
}


export default function (pi: ExtensionAPI) {
	let streaming = false;
	let turnCount = 0;
	const activeModel = createActiveModelState();
	const fastMode = createStatuslineFlagState();

	pi.events.on(CODEX_FAST_EVENT, (payload) => {
		const active = Boolean(payload && typeof payload === "object" && (payload as { active?: unknown }).active === true);
		fastMode.set(active);
	});

	pi.on("session_start", async (_event, ctx) => {
		activeModel.set(ctx.model);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const unbindModelRender = activeModel.bindRender(() => tui.requestRender());
			const unbindFastRender = fastMode.bindRender(() => tui.requestRender());
			const refreshTimer = setInterval(() => tui.requestRender(), 30_000);
			refreshTimer.unref?.();

			return {
				dispose() {
					unbindModelRender();
					unbindFastRender();
					unsub();
					clearInterval(refreshTimer);
				},
				invalidate() {},
				render(width: number): string[] {
					// --- Collect token usage ---
					let input = 0,
						output = 0,
						cacheRead = 0,
						cost = 0;
					for (const e of ctx.sessionManager.getBranch()) {
						if (e.type === "message" && e.message.role === "assistant") {
							const m = e.message as AssistantMessage;
							input += m.usage.input;
							output += m.usage.output;
							cacheRead += m.usage.cacheRead ?? 0;
							cost += m.usage.cost.total;
						}
					}

					const fmt = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);

					// --- Git branch ---
					const branch = footerData.getGitBranch();

					// --- Model info ---
					const model = activeModel.get() ?? ctx.model;
					const modelId = model?.id ?? "no-model";
					const providerId = model?.provider ?? "";

					// --- Remaining quota/context bars ---
					// Both bars mean the same thing: more filled cells = more capacity remaining.
					const contextUsage = ctx.getContextUsage();
					const contextRemaining = contextUsage?.percent == null
						? null
						: Math.max(0, Math.min(100, 100 - contextUsage.percent));
					const contextTotal = contextUsage?.contextWindow ?? model?.contextWindow ?? null;
					const contextRemainingTokens = contextUsage?.tokens == null || contextTotal == null
						? null
						: Math.max(0, contextTotal - contextUsage.tokens);
					// --- Provider capacity bar (only providers with an official usage API) ---
					// Codex OAuth accounts use independent weekly caches; the two NewAPI
					// protocol aliases deliberately share one account/cache.
					const subscriptionProvider = SUBSCRIPTION_PROVIDERS[providerId];
					const barWidth = Math.min(10, Math.max(4, Math.floor(width * 0.055)));
					const capacity = (label: string, remaining: number | null, unlimited = false) => {
						const valueColor = unlimited
							? "accent"
							: remaining == null
								? "dim"
								: remaining <= 10
									? "error"
									: remaining <= 25
										? "warning"
										: "accent";
						const filled = unlimited ? barWidth : remaining == null ? 0 : Math.round((remaining / 100) * barWidth);
						const cells = theme.fg(valueColor, "━".repeat(filled)) + theme.fg("dim", "─".repeat(barWidth - filled));
						const value = unlimited ? "∞" : remaining == null ? "N/A" : `${Math.round(remaining)}%`;
						return `${theme.fg("muted", label)} ${theme.fg(valueColor, value)} ${cells}`;
					};
					let quotaBar = "";
					if (subscriptionProvider) {
						const quota = readSubscriptionQuota(AGENT_DIR, providerId);
						if (quota) {
							const deadline = quota.resetsAt ? formatResetCountdown(quota.resetsAt) : null;
							const stale = quota.updatedAt !== undefined && Date.now() - quota.updatedAt > 30 * 60_000;
							quotaBar = capacity(subscriptionProvider.label, quota.remaining, quota.unlimited) +
								(deadline ? ` ${theme.fg("dim", `${quota.deadlineLabel ?? "RESET"} ${deadline}`)}` : "") +
								(stale ? ` ${theme.fg("dim", "CACHED")}` : "");
						}
					}
					const contextBar = capacity("CTX", contextRemaining);
					const contextAmounts = contextTotal == null
						? theme.fg("dim", "N/A")
						: theme.fg("dim", `${contextRemainingTokens == null ? "?" : fmt(contextRemainingTokens)}/${fmt(contextTotal)} remaining`);
					const thinking = pi.getThinkingLevel();
					const thinkingLabel = theme.fg(thinking === "off" ? "dim" : "accent", `THINK ${thinking}`);
					const fastLabel = fastMode.get() ? theme.fg("warning", "⚡FAST") : "";

					// --- Status indicator ---
					const statusIcon = streaming
						? theme.fg("accent", "⟳")
						: theme.fg("success", "●");

					// --- Build segments ---
					const turnLabel = theme.fg("dim", `T${turnCount}`);
					const tokenInfo = theme.fg("dim", `↑${fmt(input)} ↓${fmt(output)}`) +
						(cacheRead > 0 ? theme.fg("dim", ` ⚡${fmt(cacheRead)}`) : "");
					const costStr = cost > 0 ? theme.fg("dim", ` $${cost.toFixed(3)}`) : "";
					const branchStr = branch ? theme.fg("muted", ` ⎇ ${branch}`) : "";
					const modelStr = theme.fg("muted", `${providerId ? providerId + "/" : ""}${modelId}`);

					// --- Compose two lines ---
					const proxyMode = readProxyMode(providerId);
					const proxyLabel = proxyMode === "direct"
						? theme.fg("success", "⚡DIRECT")
						: theme.fg("warning", `⇄ ${proxyMode}`);
					const firstLeft = [statusIcon, proxyLabel, fastLabel, thinkingLabel, turnLabel, `${tokenInfo}${costStr}`]
						.filter(Boolean)
						.join(" ");
					const firstRight = `${modelStr}${branchStr}`;
					const firstGap = Math.max(1, width - visibleWidth(firstLeft) - visibleWidth(firstRight));
					const firstLine = firstLeft + " ".repeat(firstGap) + firstRight;

					const secondSegments = [quotaBar, `${contextBar} ${contextAmounts}`].filter(Boolean);
					const secondLine = secondSegments.join("   ");
					return [truncateToWidth(firstLine, width), truncateToWidth(secondLine, width)];
				},
			};
		});

		// Set animated working indicator
		ctx.ui.setWorkingIndicator({
			frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"].map((frame) =>
				ctx.ui.theme.fg("dim", frame),
			),
			intervalMs: 80,
		});
	});

	pi.on("model_select", async (event) => {
		activeModel.set(event.model);
	});

	pi.on("turn_start", async () => {
		turnCount++;
		streaming = true;
	});

	pi.on("message_update", async (event, ctx) => {
		const type = event.assistantMessageEvent.type;
		if (type === "thinking_start" || type === "thinking_delta") {
			ctx.ui.setWorkingMessage("Thinking…");
		} else if (
			type === "text_start" ||
			type === "text_delta" ||
			type === "toolcall_start" ||
			type === "toolcall_delta"
		) {
			ctx.ui.setWorkingMessage(undefined);
		}
	});

	pi.on("turn_end", async (_event, ctx) => {
		streaming = false;
		ctx.ui.setWorkingMessage(undefined);
	});

}
