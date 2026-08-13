/**
 * BTW — "by the way" side conversations.
 *
 * Opens an ephemeral, multi-turn side conversation that inherits the main
 * thread's context as read-only reference material. Modelled on Codex's
 * `/side` (aka `/btw`) command, with two deliberate differences:
 *
 *   1. The side session lives entirely in memory (SessionManager.inMemory),
 *      so it can never appear in `/resume` and leaves no crash residue.
 *      Codex achieves this with a persisted-but-ephemeral thread flag.
 *   2. Mutation is prevented structurally (read-only tool allowlist) rather
 *      than by prompt instruction alone, which is what Codex does.
 *
 * Unlike Claude Code's one-shot btw, questioning here is continuous: the
 * panel stays open and each Enter is another turn against the same session.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openBtwPanel } from "./panel.ts";
import { createBtwSession, persistBtwSession, renderParentSnapshot } from "./session.ts";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

interface BtwSettings {
	/** Character budget for the inherited main-thread snapshot. */
	seedCharBudget: number;
	/** Allow `/keep` to persist the side conversation (phase 2). */
	allowKeep: boolean;
}

function loadSettings(): BtwSettings {
	let raw: Partial<BtwSettings> = {};
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed.btw === "object" && parsed.btw !== null) {
			raw = parsed.btw as Partial<BtwSettings>;
		}
	} catch {
		/* defaults */
	}
	return {
		seedCharBudget:
			typeof raw.seedCharBudget === "number" && raw.seedCharBudget > 0 ? raw.seedCharBudget : 12_000,
		allowKeep: raw.allowKeep === true,
	};
}

export default function btw(pi: ExtensionAPI) {
	let open = false;

	async function runBtw(args: string, ctx: any) {
		if (open) {
			ctx.ui.notify("BTW 已经开着了", "warning");
			return;
		}

		const settings = loadSettings();
		const question = args.trim();

		// Inherit the main thread as read-only reference context.
		const snapshot = renderParentSnapshot(ctx, settings.seedCharBudget);

		let handle: Awaited<ReturnType<typeof createBtwSession>>;
		try {
			handle = await createBtwSession({ ctx, snapshot: snapshot.text });
		} catch (e: any) {
			ctx.ui.notify(`BTW 启动失败: ${String(e?.message ?? e).slice(0, 160)}`, "error");
			return;
		}

		// Warn if the model fell back — this happens when the parent's custom
		// provider could not be inherited, and is worth surfacing rather than
		// silently answering with a different model.
		const parentModelId = ctx.model?.id;
		const sideModelId = handle.session.model?.id;
		if (parentModelId && sideModelId && parentModelId !== sideModelId) {
			ctx.ui.notify(`BTW 用的是 ${sideModelId}（主会话是 ${parentModelId}）`, "warning");
		}

		open = true;
		try {
			const result = await openBtwPanel({
				ctx,
				session: handle.session,
				parentName: snapshot.name,
				initialQuestion: question || undefined,
				allowKeep: settings.allowKeep,
			});

			if (result.keep && settings.allowKeep) {
				try {
					const path = await persistBtwSession(handle.session, {
						cwd: ctx.cwd,
						name: result.keepName,
					});
					ctx.ui.notify(`BTW 已保存到 /resume：${path}`, "info");
				} catch (e: any) {
					ctx.ui.notify(`BTW 保存失败：${String(e?.message ?? e).slice(0, 160)}`, "error");
				}
			} else if (result.turns > 0) {
				ctx.ui.notify(`BTW 已关闭并丢弃（${result.turns} 轮）`, "info");
			}
		} finally {
			open = false;
			await handle.dispose();
		}
	}

	pi.registerCommand("btw", {
		description: "开一个临时侧边对话（继承上下文、可多轮追问、不落盘）",
		handler: async (args, ctx) => {
			await runBtw(args ?? "", ctx);
		},
	});

	pi.registerCommand("side", {
		description: "/btw 的别名（对齐 Codex 命名）",
		handler: async (args, ctx) => {
			await runBtw(args ?? "", ctx);
		},
	});
}
