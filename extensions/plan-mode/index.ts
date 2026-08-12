/**
 * Plan Mode Extension
 *
 * Implements Claude Code–style plan mode for Pi:
 * - Model calls `enter_plan_mode` → write tools are blocked
 * - Model uses `ask_user` → interactive options + Other free-form
 * - Model calls `exit_plan_mode` with a plan summary → user approves/edits/rejects
 * - On approve → write tools unblocked, model proceeds to implement
 *
 * The model is guided via promptGuidelines to use these tools proactively.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

const WRITE_TOOLS = new Set(["bash", "edit", "write"]);

export default function planMode(pi: ExtensionAPI) {
	let inPlanMode = false;
	let planModeReason = "";
	let turnsSincePlanStart = 0;

	// --- Inject plan-mode status into system prompt ---
	pi.on("before_agent_start", async () => {
		if (!inPlanMode) return {};
		return {
			systemPrompt:
				"[PLAN MODE ACTIVE]\n" +
				"You are currently in PLAN MODE. Write tools (bash, edit, write) are BLOCKED.\n" +
				"Your job: analyze, explore (read/grep/find), present options (ask_user), then present final plan (exit_plan_mode).\n" +
				"Do NOT attempt to write files or run destructive commands — they will be rejected.\n" +
				`Plan reason: ${planModeReason || "proactive planning"}\n`,
		};
	});

	// --- Block write tools when in plan mode ---
	pi.on("tool_call", async (event) => {
		if (!inPlanMode) return { block: false };
		if (WRITE_TOOLS.has(event.toolName)) {
			return {
				block: true,
				reason:
					"⚠️ Plan mode is active — write tools are blocked. " +
					"Present your plan with `exit_plan_mode` for user approval first.",
				terminate: false,
			};
		}
		return { block: false };
	});

	// --- Track turns for auto-prompt if model forgets ---
	pi.on("turn_start", async () => {
		if (inPlanMode) turnsSincePlanStart++;
	});

	// --- enter_plan_mode tool ---
	pi.registerTool({
		name: "enter_plan_mode",
		label: "Enter Plan Mode",
		description:
			"Enter plan mode to explore the codebase and design an approach before coding. " +
			"Use this proactively for non-trivial tasks, architectural decisions, multi-file changes, " +
			"or when multiple valid approaches exist. In plan mode, write tools (bash, edit, write) are " +
			"blocked — you can only read, search, and ask the user questions.",
		promptSnippet: "Enter read-only planning phase for non-trivial tasks",
		promptGuidelines: [
			"Call enter_plan_mode BEFORE starting non-trivial implementation tasks.",
			"In plan mode: explore code with read/grep/find, then present options via ask_user.",
			"When your plan is ready, call exit_plan_mode with a summary for user approval.",
			"Do NOT skip planning for tasks touching >2 files or with multiple valid approaches.",
		],
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "Brief reason for entering plan mode (optional)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			inPlanMode = true;
			planModeReason = params.reason ?? "";
			turnsSincePlanStart = 0;
			ctx.ui.notify("📋 Plan mode active — write tools blocked", "info");
			return {
				content: [
					{
						type: "text",
						text: [
							"Plan mode activated.",
							params.reason ? `Reason: ${params.reason}` : "",
							"",
							"Available actions:",
							"• Read/grep/find — explore the codebase",
							"• ask_user — present options or clarify requirements",
							"• exit_plan_mode — present final plan for user approval",
							"",
							"Blocked: bash, edit, write (until plan is approved)",
						].filter(Boolean).join("\n"),
					},
				],
			};
		},
		renderCall(args, theme) {
			const reason = args.reason ? `: ${args.reason}` : "";
			return new Text(theme.fg("accent", `📋 Enter Plan Mode${reason}`), 0, 0);
		},
		renderResult(_result, _options, theme) {
			return new Text(theme.fg("success", "✓ Plan mode active — write tools blocked"), 0, 0);
		},
	});

	// --- ask_user tool ---
	pi.registerTool({
		name: "ask_user",
		label: "Ask User",
		description:
			"Ask the user a question with numbered options. Always include meaningful choices. " +
			"An 'Other' free-form input option is automatically appended. " +
			"Use this to clarify requirements, present architectural choices, or gather preferences.",
		promptSnippet: "Ask user a multiple-choice question (Other option auto-added)",
		parameters: Type.Object({
			question: Type.String({ description: "The question to ask" }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "Option label" }),
					description: Type.Optional(Type.String({ description: "Brief explanation of tradeoffs" })),
				}),
				{ description: "2-5 options for the user", minItems: 1 },
			),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "Error: interactive UI not available" }],
				};
			}

			interface DisplayOption {
				label: string;
				description?: string;
				isOther?: boolean;
			}

			const allOptions: DisplayOption[] = [
				...params.options,
				{ label: "Other — 请描述你的想法", isOther: true },
			];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean; index?: number } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let editMode = false;
					let cachedLines: string[] | undefined;

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

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) done({ answer: trimmed, wasCustom: true });
						else {
							editMode = false;
							editor.setText("");
							refresh();
						}
					};

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (editMode) {
							if (matchesKey(data, Key.escape)) {
								editMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}
						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
						} else if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
							refresh();
						} else if (matchesKey(data, Key.enter)) {
							const selected = allOptions[optionIndex];
							if (selected.isOther) {
								editMode = true;
								refresh();
							} else {
								done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
							}
						} else if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;
						const lines: string[] = [];
						const w = Math.max(1, width);
						lines.push(theme.fg("accent", "─".repeat(w)));
						lines.push(...wrapTextWithAnsi(` ${theme.fg("text", params.question)}`, w));
						lines.push("");
						for (let i = 0; i < allOptions.length; i++) {
							const opt = allOptions[i];
							const sel = i === optionIndex;
							const prefix = sel ? theme.fg("accent", "> ") : "  ";
							const label = `${i + 1}. ${opt.label}`;
							const color = sel ? "accent" : "text";
							lines.push(...wrapTextWithAnsi(`${prefix}${theme.fg(color, label)}`, w));
							if (opt.description) {
								lines.push(...wrapTextWithAnsi(`     ${theme.fg("muted", opt.description)}`, w));
							}
						}
						if (editMode) {
							lines.push("");
							lines.push(` ${theme.fg("muted", "你的想法:")}`);
							for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
						}
						lines.push("");
						lines.push(
							editMode
								? ` ${theme.fg("dim", "Enter 提交 • Esc 返回选项")}`
								: ` ${theme.fg("dim", "↑↓ 选择 • Enter 确认 • Esc 取消")}`,
						);
						lines.push(theme.fg("accent", "─".repeat(w)));
						cachedLines = lines;
						return lines;
					}

					return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
				},
			);

			if (!result) {
				return { content: [{ type: "text", text: "用户取消了选择" }] };
			}
			if (result.wasCustom) {
				return { content: [{ type: "text", text: `用户回复: ${result.answer}` }] };
			}
			return { content: [{ type: "text", text: `用户选择了: ${result.index}. ${result.answer}` }] };
		},
		renderCall(args, theme) {
			const opts = args.options.map((o: { label: string }, i: number) => `${i + 1}. ${o.label}`).join(", ");
			return new Text(
				theme.fg("accent", "❓ ") + theme.fg("text", args.question) + "\n" + theme.fg("dim", `  ${opts}, Other`),
				0,
				0,
			);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			const answer = text?.type === "text" ? text.text : "";
			if (answer.includes("取消")) return new Text(theme.fg("warning", "— 已取消"), 0, 0);
			return new Text(theme.fg("success", "✓ ") + theme.fg("text", answer), 0, 0);
		},
	});

	// --- exit_plan_mode tool ---
	pi.registerTool({
		name: "exit_plan_mode",
		label: "Exit Plan Mode",
		description:
			"Present your plan to the user for approval and exit plan mode. " +
			"Call this when your implementation plan is ready. The user can approve, reject, or provide feedback.",
		promptSnippet: "Present plan for user approval → unblock write tools",
		parameters: Type.Object({
			plan: Type.String({ description: "Complete implementation plan in markdown format" }),
		}),
		executionMode: "sequential",
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") {
				inPlanMode = false;
				return { content: [{ type: "text", text: "Plan approved (non-interactive mode)" }] };
			}

			const result = await ctx.ui.custom<"approve" | "reject" | { feedback: string } | null>(
				(tui, theme, _kb, done) => {
					let optionIndex = 0;
					let feedbackMode = false;
					let cachedLines: string[] | undefined;

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

					editor.onSubmit = (value) => {
						const trimmed = value.trim();
						if (trimmed) done({ feedback: trimmed });
						else {
							feedbackMode = false;
							editor.setText("");
							refresh();
						}
					};

					const choices = [
						{ label: "✅ 批准 — 开始实现", value: "approve" as const },
						{ label: "❌ 拒绝 — 重新规划", value: "reject" as const },
						{ label: "✏️  提供修改意见", value: "feedback" as const },
					];

					function refresh() {
						cachedLines = undefined;
						tui.requestRender();
					}

					function handleInput(data: string) {
						if (feedbackMode) {
							if (matchesKey(data, Key.escape)) {
								feedbackMode = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}
						if (matchesKey(data, Key.up)) {
							optionIndex = Math.max(0, optionIndex - 1);
							refresh();
						} else if (matchesKey(data, Key.down)) {
							optionIndex = Math.min(choices.length - 1, optionIndex + 1);
							refresh();
						} else if (matchesKey(data, Key.enter)) {
							const choice = choices[optionIndex];
							if (choice.value === "feedback") {
								feedbackMode = true;
								refresh();
							} else {
								done(choice.value);
							}
						} else if (matchesKey(data, Key.escape)) {
							done(null);
						}
					}

					function render(width: number): string[] {
						if (cachedLines) return cachedLines;
						const lines: string[] = [];
						const w = Math.max(1, width);
						lines.push(theme.fg("accent", "═".repeat(w)));
						lines.push(theme.fg("accent", " 📋 实现计划"));
						lines.push(theme.fg("accent", "─".repeat(w)));
						for (const line of params.plan.split("\n")) {
							lines.push(...wrapTextWithAnsi(` ${theme.fg("text", line)}`, w));
						}
						lines.push(theme.fg("accent", "─".repeat(w)));
						lines.push("");
						for (let i = 0; i < choices.length; i++) {
							const sel = i === optionIndex;
							const prefix = sel ? theme.fg("accent", "> ") : "  ";
							const color = sel ? "accent" : "text";
							lines.push(`${prefix}${theme.fg(color, choices[i].label)}`);
						}
						if (feedbackMode) {
							lines.push("");
							lines.push(` ${theme.fg("muted", "修改意见:")}`);
							for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
						}
						lines.push("");
						lines.push(
							feedbackMode
								? ` ${theme.fg("dim", "Enter 提交 • Esc 返回")}`
								: ` ${theme.fg("dim", "↑↓ 选择 • Enter 确认 • Esc 取消")}`,
						);
						lines.push(theme.fg("accent", "═".repeat(w)));
						cachedLines = lines;
						return lines;
					}

					return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
				},
			);

			if (result === "approve") {
				inPlanMode = false;
				ctx.ui.notify("✅ Plan approved — write tools unblocked", "info");
				return {
					content: [
						{
							type: "text",
							text: "User APPROVED the plan. Write tools are now unblocked. Proceed with implementation.",
						},
					],
				};
			}

			if (result === "reject") {
				// Stay in plan mode
				return {
					content: [
						{
							type: "text",
							text: "User REJECTED the plan. Revise your approach. You are still in plan mode.",
						},
					],
				};
			}

			if (result && typeof result === "object" && "feedback" in result) {
				// Stay in plan mode with feedback
				return {
					content: [
						{
							type: "text",
							text: `User provided feedback on the plan: "${result.feedback}"\n\nRevise your plan accordingly and call exit_plan_mode again when ready.`,
						},
					],
				};
			}

			// Cancelled — stay in plan mode
			return {
				content: [{ type: "text", text: "User cancelled. You are still in plan mode. Continue planning or ask_user for clarification." }],
			};
		},
		renderCall(args, theme) {
			const preview = args.plan.split("\n").slice(0, 3).join("\n");
			return new Text(theme.fg("accent", "📋 Exit Plan Mode\n") + theme.fg("dim", preview + "\n…"), 0, 0);
		},
		renderResult(result, _options, theme) {
			const text = result.content[0];
			const msg = text?.type === "text" ? text.text : "";
			if (msg.includes("APPROVED")) return new Text(theme.fg("success", "✅ Plan approved — implementing"), 0, 0);
			if (msg.includes("REJECTED")) return new Text(theme.fg("error", "❌ Plan rejected — revising"), 0, 0);
			if (msg.includes("feedback")) return new Text(theme.fg("warning", "✏️  Feedback received — revising"), 0, 0);
			return new Text(theme.fg("dim", "— cancelled"), 0, 0);
		},
	});

	// --- /plan command to manually enter plan mode ---
	pi.registerCommand("plan", {
		description: "Toggle plan mode (or '/plan off' to force exit)",
		handler: async (args, ctx) => {
			const arg = (args ?? "").toString().trim().toLowerCase();
			if (arg === "off" || arg === "exit") {
				inPlanMode = false;
				ctx.ui.notify("Plan mode: OFF — write tools allowed", "info");
			} else if (arg === "on" || arg === "" || arg === "enter") {
				if (inPlanMode) {
					ctx.ui.notify("Plan mode is already active", "info");
				} else {
					inPlanMode = true;
					planModeReason = arg === "on" || arg === "enter" || !arg ? "user requested" : arg;
					turnsSincePlanStart = 0;
					ctx.ui.notify("📋 Plan mode: ON — write tools blocked", "info");
				}
			} else {
				// Treat as reason
				inPlanMode = true;
				planModeReason = arg;
				turnsSincePlanStart = 0;
				ctx.ui.notify(`📋 Plan mode: ON — ${arg}`, "info");
			}
		},
	});
}
