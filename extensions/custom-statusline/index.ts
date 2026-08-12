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

const CODEX_WEEKLY_CACHE = join(homedir(), ".pi", "agent", "cache", "codex-weekly-usage.json");
const ROUTING_PATH = join(homedir(), ".pi", "agent", "provider-routing.json");

function readProxyMode(provider: string): string {
	try {
		const data = JSON.parse(readFileSync(ROUTING_PATH, "utf8")) as { providers?: Record<string, { mode?: string; proxyUrl?: string }> };
		const entry = data.providers?.[provider];
		if (!entry) return "direct";
		if (entry.mode === "proxy") return `proxy:${entry.proxyUrl ?? "?"}`.replace(/^proxy:http:\/\//, "proxy:");
		return entry.mode ?? "direct";
	} catch {
		return "?";
	}
}

function readCodexRemaining(): number | null {
	try {
		const data = JSON.parse(readFileSync(CODEX_WEEKLY_CACHE, "utf8")) as { remainingPercent?: unknown };
		return typeof data.remainingPercent === "number" && Number.isFinite(data.remainingPercent)
			? Math.max(0, Math.min(100, data.remainingPercent))
			: null;
	} catch {
		return null;
	}
}

export default function (pi: ExtensionAPI) {
	let streaming = false;
	let turnCount = 0;

	pi.on("session_start", async (_event, ctx) => {
		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const refreshTimer = setInterval(() => tui.requestRender(), 30_000);
			refreshTimer.unref?.();

			return {
				dispose() {
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
					const modelId = ctx.model?.id ?? "no-model";
					const providerId = (ctx.model as any)?.provider ?? "";

					// --- Remaining quota/context bars ---
					// Both bars mean the same thing: more filled cells = more capacity remaining.
					const contextUsage = ctx.getContextUsage();
					const contextRemaining = contextUsage?.percent == null
						? null
						: Math.max(0, Math.min(100, 100 - contextUsage.percent));
					const contextTotal = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? null;
					const contextRemainingTokens = contextUsage?.tokens == null || contextTotal == null
						? null
						: Math.max(0, contextTotal - contextUsage.tokens);
					const codexRemaining = readCodexRemaining();
					const barWidth = Math.min(10, Math.max(4, Math.floor(width * 0.055)));
					const capacity = (label: string, remaining: number | null) => {
						const color = remaining == null
							? "dim"
							: remaining <= 10
								? "error"
								: remaining <= 25
									? "warning"
									: "success";
						const filled = remaining == null ? 0 : Math.round((remaining / 100) * barWidth);
						const cells = theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(barWidth - filled));
						const value = remaining == null ? "N/A" : `${Math.round(remaining)}%`;
						return `${theme.fg(color, `${label} ${value}`)} ${cells}`;
					};
					const quotaBar = capacity("CODEX WEEK", codexRemaining);
					const contextBar = capacity("CTX", contextRemaining);
					const contextAmounts = contextTotal == null
						? theme.fg("dim", "N/A")
						: theme.fg("dim", `${contextRemainingTokens == null ? "?" : fmt(contextRemainingTokens)}/${fmt(contextTotal)} remaining`);
					const thinking = pi.getThinkingLevel();
					const thinkingLabel = theme.fg(thinking === "off" ? "dim" : "accent", `THINK ${thinking}`);

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
					const firstLeft = `${statusIcon} ${proxyLabel} ${thinkingLabel} ${turnLabel} ${tokenInfo}${costStr}`;
					const firstRight = `${modelStr}${branchStr}`;
					const firstGap = Math.max(1, width - visibleWidth(firstLeft) - visibleWidth(firstRight));
					const firstLine = firstLeft + " ".repeat(firstGap) + firstRight;

					const secondLine = `${quotaBar}   ${contextBar} ${contextAmounts}`;
					return [truncateToWidth(firstLine, width), truncateToWidth(secondLine, width)];
				},
			};
		});

		// Set animated working indicator
		ctx.ui.setWorkingIndicator({
			frames: [
				ctx.ui.theme.fg("dim", "⠋"),
				ctx.ui.theme.fg("dim", "⠙"),
				ctx.ui.theme.fg("dim", "⠹"),
				ctx.ui.theme.fg("accent", "⠸"),
				ctx.ui.theme.fg("accent", "⠼"),
				ctx.ui.theme.fg("accent", "⠴"),
				ctx.ui.theme.fg("dim", "⠦"),
				ctx.ui.theme.fg("dim", "⠧"),
			],
			intervalMs: 80,
		});
	});

	pi.on("turn_start", async () => {
		turnCount++;
		streaming = true;
	});

	pi.on("turn_end", async () => {
		streaming = false;
	});
}
