/**
 * BTW panel — a modal overlay hosting a multi-turn side conversation.
 *
 * Renders a scrollable transcript plus an input editor. Streaming output is
 * re-derived from the agent session's messages on every event, so there is no
 * incremental bookkeeping to get out of sync.
 */

import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	applyBtwPaging,
	createBtwScrollState,
	layoutBtwViewport,
	resolveBtwPagingInput,
} from "./panel-scroll.ts";

export interface BtwPanelResult {
	/** True if the user asked to keep (persist) the conversation. */
	keep: boolean;
	/** Optional session name supplied via `/keep <name>`. */
	keepName?: string;
	/** Number of user turns taken. */
	turns: number;
}

interface Line {
	role: "user" | "assistant" | "tool" | "system";
	text: string;
}

/** Flatten the session's messages (plus any in-flight message) into display lines. */
function buildLines(session: any, inflight: any): Line[] {
	const out: Line[] = [];
	const msgs: any[] = [...(session?.messages ?? [])];
	if (inflight && msgs[msgs.length - 1] !== inflight && !msgs.some((m) => m === inflight)) {
		msgs.push(inflight);
	}
	for (const m of msgs) {
		if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
		const content = m.content ?? [];
		if (m.role === "user") {
			const text = content
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join("")
				.trim();
			// Hidden seed entries are custom messages, not user text; skip empties.
			if (text) out.push({ role: "user", text });
			continue;
		}
		for (const c of content) {
			if (c.type === "text" && c.text?.trim()) {
				out.push({ role: "assistant", text: c.text });
			} else if (c.type === "toolCall") {
				const arg =
					c.arguments?.path ??
					c.arguments?.pattern ??
					c.arguments?.query ??
					c.arguments?.file_path ??
					"";
				out.push({ role: "tool", text: `${c.name}(${String(arg).slice(0, 60)})` });
			}
		}
	}
	return out;
}

export interface OpenPanelOptions {
	ctx: any;
	session: any;
	/** Parent session display name, shown in the header. */
	parentName?: string;
	/** Question to send immediately on open. */
	initialQuestion?: string;
	/** Whether persisting is available (phase 2). */
	allowKeep?: boolean;
}

export async function openBtwPanel(opts: OpenPanelOptions): Promise<BtwPanelResult> {
	const { ctx, session, parentName, initialQuestion, allowKeep = false } = opts;

	return ctx.ui.custom<BtwPanelResult>(
		(tui: any, theme: any, keybindings: any, done: (r: BtwPanelResult) => void) => {
			let cached: string[] | undefined;
			let inflight: any = null;
			let streaming = false;
			let statusText = "";
			const scroll = createBtwScrollState();
			let turns = 0;
			let keep = false;
			let keepName: string | undefined;
			let closing = false;
			let queuedSteer = 0;
			let queuedFollow = 0;

			const editorTheme: EditorTheme = {
				borderColor: (s) => theme.fg("accent", s),
				selectList: {
					selectedPrefix: (t) => theme.fg("accent", t),
					selectedText: (t) => theme.fg("accent", t),
					description: (t) => theme.fg("muted", t),
					scrollInfo: (t) => theme.fg("dim", t),
					noMatch: (t) => theme.fg("warning", t),
				},
			};
			const editor = new Editor(tui, editorTheme);

			function refresh() {
				cached = undefined;
				tui.requestRender();
			}

			const unsubscribe = session.subscribe?.((ev: any) => {
				switch (ev?.type) {
					case "turn_start":
						streaming = true;
						statusText = "thinking…";
						break;
					case "message_update":
						inflight = ev.message;
						statusText = "";
						break;
					case "message_end":
						inflight = null;
						break;
					case "tool_execution_start":
						statusText = `${ev.toolName}…`;
						break;
					case "tool_execution_end":
						statusText = "";
						break;
					case "turn_end":
					case "agent_settled":
						streaming = false;
						inflight = null;
						statusText = "";
						queuedSteer = 0;
						queuedFollow = 0;
						break;
					case "queue_update":
						queuedSteer = ev.steering?.length ?? 0;
						queuedFollow = ev.followUp?.length ?? 0;
						break;
					case "error":
						streaming = false;
						statusText = `error: ${String(ev.error?.message ?? ev.error ?? "unknown").slice(0, 80)}`;
						break;
				}
				// In follow mode new output stays pinned to the bottom. While the user
				// is reading history, layoutBtwViewport preserves the absolute view.
				if (scroll.followOutput) scroll.scrollBack = 0;
				refresh();
			});

			function finish() {
				if (closing) return;
				closing = true;
				try {
					unsubscribe?.();
				} catch {
					/* ignore */
				}
				done({ keep, keepName, turns });
			}

			async function send(text: string, kind: "enter" | "tab" = "enter") {
				const wasStreaming = streaming;
				turns++;
				streaming = true;
				statusText = "thinking…";
				refresh();
				try {
					if (wasStreaming) {
						// Agent 忙碌中：Enter = steer（当前工具批结束后插入），Tab = follow-up（全部结束后再问）
						if (kind === "tab") {
							await session.followUp(text);
							statusText = "follow-up 已排队，完成后追问";
						} else {
							await session.steer(text);
							statusText = "已打断，指令插入队列";
						}
					} else {
						await session.prompt(text);
					}
				} catch (e: any) {
					streaming = false;
					statusText = `error: ${String(e?.message ?? e).slice(0, 80)}`;
				}
				// 空闲发送的 prompt 结束后恢复；流式排队路径保持忙碌态，由事件驱动恢复
				if (!wasStreaming) {
					streaming = false;
				}
				inflight = null;
				refresh();
			}

			editor.onSubmit = (value: string) => {
				const trimmed = value.trim();
				editor.setText("");
				if (!trimmed) {
					refresh();
					return;
				}
				if ((trimmed === "/keep" || trimmed.startsWith("/keep ")) && allowKeep) {
					keep = true;
					keepName = trimmed.slice("/keep".length).trim() || undefined;
					statusText = keepName ? `will save as: ${keepName}` : "will be saved on close";
					refresh();
					return;
				}
				if (trimmed === "/exit" || trimmed === "/close") {
					finish();
					return;
				}
				void send(trimmed);
			};

			function handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					if (streaming) {
						session.abort?.();
						streaming = false;
						statusText = "aborted";
						refresh();
					} else {
						finish();
					}
					return;
				}
				const paging = resolveBtwPagingInput(data, keybindings);
				if (paging) {
					applyBtwPaging(scroll, paging);
					refresh();
					return;
				}
				if (matchesKey(data, Key.tab)) {
					// Tab = follow-up：忙碌时排队到本轮全部结束，空闲时即普通提问
					const value = editor.getText().trim();
					editor.setText("");
					if (value) {
						void send(value, "tab");
					} else {
						refresh();
					}
					return;
				}
				editor.handleInput(data);
				refresh();
			}

			function render(width: number): string[] {
				if (cached) return cached;
				const w = Math.max(20, width);
				const lines: string[] = [];

				// Header
				const from = parentName ? ` · from ${parentName}` : "";
				const modelId = session.model?.id ? ` · ${session.model.id}` : "";
				lines.push(theme.fg("accent", "━".repeat(w)));
				lines.push(
					` ${theme.fg("accent", "BTW")}${theme.fg("muted", from)}${theme.fg("dim", modelId)}` +
						theme.fg("dim", "  (ephemeral)"),
				);
				lines.push(theme.fg("accent", "─".repeat(w)));

				// Transcript
				const body: string[] = [];
				for (const ln of buildLines(session, inflight)) {
					if (ln.role === "user") {
						body.push(...wrapTextWithAnsi(theme.fg("accent", "› ") + theme.fg("text", ln.text), w));
					} else if (ln.role === "assistant") {
						body.push(...wrapTextWithAnsi(theme.fg("text", ln.text), w));
					} else if (ln.role === "tool") {
						body.push(...wrapTextWithAnsi(theme.fg("dim", `  ⚙ ${ln.text}`), w));
					}
					body.push("");
				}
				if (body.length === 0) {
					body.push(theme.fg("muted", " Ask anything about the main conversation or the codebase."));
					body.push(theme.fg("dim", " Context from the main thread is loaded as reference."));
					body.push("");
				}

				// Viewport: reserve room for header (3) + editor (~3) + footer (2).
				// The TUI object exposes no row count, so read the terminal directly.
				const termRows = process.stdout.rows || 24;
				const maxBody = Math.max(3, Math.floor(termRows * 0.8) - 9);
				const viewport = layoutBtwViewport(scroll, body.length, maxBody);
				let view = body.slice(viewport.start, viewport.end);
				if (!scroll.followOutput && scroll.scrollBack > 0) {
					view = [theme.fg("dim", `  ↓ ${scroll.scrollBack} newer line(s) · history paused`), ...view];
				}
				lines.push(...view);

				// Status
				if (statusText) {
					lines.push(` ${theme.fg(statusText.startsWith("error") ? "warning" : "muted", statusText)}`);
				}

				// Input
				lines.push(theme.fg("accent", "─".repeat(w)));
				for (const l of editor.render(Math.max(1, w - 2))) lines.push(` ${l}`);

				// Footer
				const hints = [
					"Enter 发送/打断",
					"Tab 追加到队尾",
					streaming ? "Esc 中断" : "Esc 关闭并丢弃",
					"Fn+↑/↓ (PgUp/PgDn) 翻页",
				];
				if (allowKeep) hints.push(keep ? "已标记保存" : "/keep 保存");
				if (queuedSteer + queuedFollow > 0) {
					lines.push(
						` ${theme.fg("muted", `⏳ 排队中：${queuedSteer} 条打断 · ${queuedFollow} 条追问`)}`,
					);
				}
				lines.push(` ${theme.fg("dim", hints.join(" • "))}`);
				lines.push(theme.fg("accent", "━".repeat(w)));

				cached = lines;
				return lines;
			}

			// Kick off the initial question, if any.
			if (initialQuestion?.trim()) {
				void send(initialQuestion.trim());
			}

			return {
				render,
				invalidate: () => {
					cached = undefined;
				},
				handleInput,
			};
		},
		{
			overlay: true,
			overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
		},
	);
}
