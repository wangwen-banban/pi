import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	getSupportedThinkingLevels,
	StringEnum,
	uuidv7,
	type Model,
	type Usage,
} from "@earendil-works/pi-ai";
import {
	getAgentDir,
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Key, Markdown, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	DEFAULT_CONFIG,
	THINKING_LEVELS,
	clampThinkingLevel,
	fallbackComplexity,
	fallbackPermission,
	mergeConfig,
	parseClassifierDecision,
	scopesOverlap,
	selectModelCandidates,
	type ClassifierDecision,
	type Complexity,
	type ContextMode,
	type PermissionMode,
	type SmartSubagentConfig,
	type ThinkingLevel,
} from "./router.ts";

const CONFIG_PATH = path.join(getAgentDir(), "subagents.json");
const RUNS_DIR = path.join(getAgentDir(), "subagent-runs");
const RESULT_OUTPUT_LIMIT = 48 * 1024;
const STDERR_LIMIT = 64 * 1024;
const PROGRESS_ITEMS_LIMIT = 8;
const COMPLETED_JOB_HOLD_MS = 60_000;
const LIVE_OUTPUT_LIMIT = 120_000;
const FINAL_STATUSES = new Set(["completed", "failed", "stopped"]);

type JobStatus = "routing" | "queued" | "running" | "completed" | "failed" | "stopped";
type LifecycleEvent = "started" | "progress" | "completed" | "failed" | "stopped";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

interface RouteDecision extends ClassifierDecision {
	modelRef: string;
	provider: string;
	modelId: string;
	modelName: string;
	providerName: string;
	effort: ThinkingLevel;
}

interface JobSnapshot {
	id: string;
	name: string;
	task: string;
	expectedOutput?: string;
	status: JobStatus;
	route?: RouteDecision;
	contextFiles: string[];
	writeScope: string[];
	cwd: string;
	createdAt: number;
	startedAt?: number;
	finishedAt?: number;
	exitCode?: number;
	output?: string;
	error?: string;
	changedFiles: string[];
	attemptedModels: string[];
	usage: UsageStats;
	logPath?: string;
	progress: string[];
}

interface Job extends JobSnapshot {
	config: SmartSubagentConfig;
	contextPath?: string;
	process?: ChildProcess;
	stdoutBuffer: string;
	liveOutput: string;
	stderr: string;
	stopRequested: boolean;
	lastProgressHookAt: number;
	fallbackRoutes: RouteDecision[];
	parentConversation: string;
	contextNotes: string;
}

interface DispatchDetails {
	job: JobSnapshot;
	requested: {
		model: string;
		effort: string;
		contextMode: string;
		complexity: string;
		permission: string;
	};
}

interface CompletionDetails {
	event: LifecycleEvent;
	job: JobSnapshot;
}

interface RouterResult {
	decision: ClassifierDecision;
	usage?: Usage;
	conversation: string;
}

function loadConfig(): SmartSubagentConfig {
	try {
		return mergeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
	} catch {
		return structuredClone(DEFAULT_CONFIG);
	}
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } => {
			return Boolean(part) && typeof part === "object" && (part as any).type === "text" && typeof (part as any).text === "string";
		})
		.map((part) => part.text)
		.join("\n");
}

function serializeParentConversation(ctx: ExtensionContext, maxChars: number): string {
	const sections: string[] = [];
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			sections.push(`Compaction summary:\n${entry.summary}`);
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textFromContent(entry.message.content).trim();
		if (text) sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	const full = sections.join("\n\n");
	if (full.length <= maxChars) return full;
	return `[Earlier parent conversation omitted]\n\n${full.slice(-maxChars)}`;
}

function relevantExcerpts(conversation: string, task: string, maxChars: number): string {
	if (!conversation.trim()) return "";
	const terms = new Set(
		task
			.toLowerCase()
			.split(/[^\p{L}\p{N}_./-]+/u)
			.filter((term) => term.length >= 3)
			.slice(0, 40),
	);
	const chunks = conversation.split(/\n\n+/).filter(Boolean);
	const ranked = chunks
		.map((chunk, index) => {
			const lower = chunk.toLowerCase();
			let score = index / Math.max(1, chunks.length) * 0.75;
			for (const term of terms) if (lower.includes(term)) score += 1;
			return { chunk, index, score };
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 8)
		.sort((a, b) => a.index - b.index);
	let result = "";
	for (const item of ranked) {
		const next = result ? `${result}\n\n${item.chunk}` : item.chunk;
		if (next.length > maxChars) break;
		result = next;
	}
	return result || conversation.slice(-maxChars);
}

function resolveAvailableModel(models: Model<any>[], reference: string): Model<any> | undefined {
	return models.find((model) => `${model.provider}/${model.id}` === reference);
}

function resolveRouterModel(
	models: Model<any>[],
	configuredRef: string,
	currentModel: Model<any> | undefined,
): Model<any> | undefined {
	return (
		resolveAvailableModel(models, configuredRef) ??
		models.find((model) => model.id === configuredRef) ??
		currentModel ??
		models[0]
	);
}

function fallbackDecision(
	task: string,
	expectedOutput: string,
	contextNotes: string,
	config: SmartSubagentConfig,
): ClassifierDecision {
	const complexity = fallbackComplexity(task, expectedOutput, contextNotes);
	return {
		complexity,
		contextMode: config.routes[complexity].context,
		permission: fallbackPermission(task),
		reason: `Rule-based fallback classified this as a ${complexity} task.`,
		contextSummary: "",
	};
}

async function classifyAndSummarize(
	ctx: ExtensionContext,
	params: {
		task: string;
		expectedOutput?: string;
		contextNotes?: string;
		contextFiles?: string[];
		complexity?: string;
		contextMode?: string;
		permission?: string;
	},
	config: SmartSubagentConfig,
	signal: AbortSignal | undefined,
): Promise<RouterResult> {
	const expectedOutput = params.expectedOutput ?? "";
	const contextNotes = params.contextNotes ?? "";
	const conversation = serializeParentConversation(ctx, config.router.maxConversationChars);
	let decision = fallbackDecision(params.task, expectedOutput, contextNotes, config);
	let usage: Usage | undefined;

	if (config.router.enabled) {
		const models = ctx.modelRegistry.getAvailable();
		const routerModel = resolveRouterModel(models, config.router.model, ctx.model);
		if (routerModel) {
			const routerEffort = clampThinkingLevel(
				config.router.effort,
				getSupportedThinkingLevels(routerModel).map(String),
			);
			const prompt = [
				"You are a sub-agent scheduler and context distiller.",
				"Classify the delegated task and extract only parent-context facts that the worker truly needs.",
				"Return one JSON object with exactly these fields:",
				'{"complexity":"simple|medium|complex|critical","context_mode":"isolated|selected|summary|full","permission":"read-only|workspace-write","reason":"short routing reason","context_summary":"focused facts, decisions, constraints and relevant paths"}',
				"Rules:",
				"- simple: bounded lookup or tiny mechanical work; medium: one-module implementation/review; complex: cross-module or deep reasoning; critical: security, data-loss, production, architecture or difficult concurrency risk.",
				"- isolated: the task is self-contained; selected: explicit files/notes plus a few facts suffice; summary: semantic parent context is needed; full: exact broad conversation details are indispensable and summary would be unsafe. Prefer selected or summary over full.",
				"- read-only for investigation/review; workspace-write only when edits or execution are required.",
				`- context_summary must be under ${config.router.maxSummaryChars} characters and must omit unrelated conversation content.`,
				"- Do not include markdown fences or any text outside JSON.",
				"",
				`TASK:\n${params.task}`,
				`EXPECTED OUTPUT:\n${expectedOutput || "Not specified"}`,
				`EXPLICIT CONTEXT FILES:\n${(params.contextFiles ?? []).join("\n") || "None"}`,
				`EXPLICIT CONTEXT NOTES:\n${contextNotes || "None"}`,
				`PARENT CONVERSATION:\n${conversation || "No parent conversation available"}`,
			].join("\n");
			try {
				const response = await ctx.modelRegistry.complete(
					routerModel,
					{
						messages: [
							{
								role: "user",
								content: [{ type: "text", text: prompt }],
								timestamp: Date.now(),
							},
						],
					},
					{
						reasoningEffort: routerEffort,
						cacheRetention: "none",
						sessionId: uuidv7(),
						signal,
					},
				);
				usage = response.usage;
				const text = response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				decision = parseClassifierDecision(text, decision);
			} catch {
				// Routing is fail-open: deterministic policy still produces a valid route.
			}
		}
	}

	if (params.complexity && params.complexity !== "auto") {
		decision.complexity = params.complexity as Complexity;
	}
	if (params.contextMode && params.contextMode !== "auto") {
		decision.contextMode = params.contextMode as ContextMode;
	} else if ((params.contextFiles?.length ?? 0) > 0 && decision.contextMode === "isolated") {
		decision.contextMode = "selected";
	}
	if (params.permission && params.permission !== "auto") {
		decision.permission = params.permission as PermissionMode;
	}
	decision.contextSummary = decision.contextSummary.slice(0, config.router.maxSummaryChars);
	return { decision, usage, conversation };
}

function buildContextPacket(
	job: Job,
	conversation: string,
	contextNotes: string,
): string {
	const route = job.route!;
	let inheritedContext = "No parent conversation was inherited. Work only from the task and repository instructions.";
	if (route.contextMode === "selected") {
		const selected = route.contextSummary || relevantExcerpts(conversation, job.task, job.config.context.maxSelectedChars);
		inheritedContext = selected || "No additional parent facts were selected.";
	} else if (route.contextMode === "summary") {
		const summary = route.contextSummary || relevantExcerpts(conversation, job.task, job.config.context.maxSelectedChars);
		inheritedContext = summary || "No relevant parent summary was available.";
	} else if (route.contextMode === "full") {
		inheritedContext = conversation.length > job.config.context.maxFullChars
			? `[Earlier content omitted]\n${conversation.slice(-job.config.context.maxFullChars)}`
			: conversation || "No parent conversation was available.";
	}

	const toolsPolicy = route.permission === "read-only"
		? "You are read-only. Do not edit files or run commands that mutate the workspace."
		: "You may edit the shared workspace only within the declared write scope. Preserve unrelated user changes.";
	const scope = job.writeScope.length > 0 ? job.writeScope.map((item) => `- ${item}`).join("\n") : "- No narrow write scope supplied; minimize changes and avoid unrelated files.";
	const files = job.contextFiles.length > 0 ? job.contextFiles.map((item) => `- ${item}`).join("\n") : "- None explicitly supplied; discover only what the task requires.";

	return [
		`You are Sub Agent ${job.name} (${job.id}).`,
		"You have an isolated conversation but share the same working directory with the parent agent.",
		"Do not delegate to another agent. Complete only the bounded assignment below.",
		toolsPolicy,
		"When finished, return a compact report with: outcome, files changed, validation performed, and remaining risks.",
		"",
		"## Effective route",
		`- Model: ${route.provider}/${route.modelId}`,
		`- Thinking: ${route.effort}`,
		`- Complexity: ${route.complexity}`,
		`- Context mode: ${route.contextMode}`,
		`- Permission: ${route.permission}`,
		`- Routing reason: ${route.reason}`,
		"",
		"## Relevant files",
		files,
		"",
		"## Allowed write scope",
		scope,
		"",
		"## Explicit notes",
		contextNotes || "None",
		"",
		`## Parent context (${route.contextMode})`,
		inheritedContext,
	].join("\n");
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

function truncateUtf8(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
	let result = value.slice(0, maxBytes);
	while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
	return `${result}\n\n[Output truncated; full result is saved in the run log.]`;
}

function snapshot(job: Job): JobSnapshot {
	return {
		id: job.id,
		name: job.name,
		task: job.task,
		expectedOutput: job.expectedOutput,
		status: job.status,
		route: job.route,
		contextFiles: [...job.contextFiles],
		writeScope: [...job.writeScope],
		cwd: job.cwd,
		createdAt: job.createdAt,
		startedAt: job.startedAt,
		finishedAt: job.finishedAt,
		exitCode: job.exitCode,
		output: job.output ? truncateUtf8(job.output, 16 * 1024) : undefined,
		error: job.error,
		changedFiles: [...job.changedFiles],
		attemptedModels: [...job.attemptedModels],
		usage: { ...job.usage },
		logPath: job.logPath,
		progress: [...job.progress],
	};
}

function formatDuration(job: JobSnapshot): string {
	const start = job.startedAt ?? job.createdAt;
	const end = job.finishedAt ?? Date.now();
	const seconds = Math.max(0, Math.round((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function displayModel(route: RouteDecision): string {
	return `${route.providerName} / ${route.modelId}`;
}

class AgentBrowser implements Component {
	private selected = 0;
	private detail = false;
	private scroll = 0;

	constructor(
		private readonly getJobs: () => Job[],
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: () => void,
		private readonly requestRender: () => void,
	) {}

	invalidate(): void {}

	private jobs(): Job[] {
		return this.getJobs().sort((a, b) => {
			const aActive = a.status === "running" || a.status === "queued" || a.status === "routing" ? 0 : 1;
			const bActive = b.status === "running" || b.status === "queued" || b.status === "routing" ? 0 : 1;
			return aActive - bActive || b.createdAt - a.createdAt;
		});
	}

	handleInput(data: string): void {
		const jobs = this.jobs();
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) {
			if (this.detail) {
				this.detail = false;
				this.scroll = 0;
				this.requestRender();
			} else this.done();
			return;
		}
		if (matchesKey(data, "q")) {
			this.done();
			return;
		}
		if (this.detail) {
			if (matchesKey(data, Key.up)) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, Key.down)) this.scroll += 1;
			else if (matchesKey(data, Key.pageUp)) this.scroll = Math.max(0, this.scroll - 12);
			else if (matchesKey(data, Key.pageDown)) this.scroll += 12;
			else if (matchesKey(data, Key.home)) this.scroll = 0;
			else if (matchesKey(data, Key.end)) this.scroll = Number.MAX_SAFE_INTEGER;
			this.requestRender();
			return;
		}
		if (!jobs.length) return;
		if (matchesKey(data, Key.up)) this.selected = (this.selected - 1 + jobs.length) % jobs.length;
		else if (matchesKey(data, Key.down)) this.selected = (this.selected + 1) % jobs.length;
		else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) {
			this.detail = true;
			this.scroll = Number.MAX_SAFE_INTEGER;
		}
		this.requestRender();
	}

	render(width: number): string[] {
		const jobs = this.jobs();
		this.selected = Math.min(this.selected, Math.max(0, jobs.length - 1));
		if (!this.detail) return this.renderList(width, jobs);
		const selected = jobs[this.selected];
		return selected ? this.renderDetail(width, selected) : this.renderList(width, jobs);
	}

	private border(width: number): string {
		return this.theme.fg("border", `─`.repeat(Math.max(1, width)));
	}

	private renderList(width: number, jobs: Job[]): string[] {
		const lines = [
			truncateToWidth(`${this.theme.fg("accent", "Sub-agents")} ${this.theme.fg("dim", "↑↓ select · Enter/→ inspect · Esc close")}`, width),
			this.border(width),
		];
		if (!jobs.length) lines.push(this.theme.fg("dim", "No visible sub-agents."));
		for (let index = 0; index < jobs.length; index++) {
			const job = jobs[index]!;
			const cursor = index === this.selected ? this.theme.fg("accent", "→ ") : "  ";
			const status = job.status === "running" ? this.theme.fg("warning", "● running") : FINAL_STATUSES.has(job.status) ? this.theme.fg(job.status === "completed" ? "success" : "error", `● ${job.status}`) : this.theme.fg("muted", `● ${job.status}`);
			const model = job.route ? `${job.route.providerName}/${job.route.modelId}` : "routing";
			lines.push(truncateToWidth(`${cursor}${status}  ${this.theme.fg(index === this.selected ? "accent" : "text", job.name)}  ${this.theme.fg("dim", `${model} · ${job.route?.effort ?? "auto"} · ${formatDuration(job)}`)}`, width));
		}
		return lines;
	}

	private renderDetail(width: number, job: Job): string[] {
		const header = [
			truncateToWidth(`${this.theme.fg("accent", "Sub-agent detail")} ${this.theme.fg("dim", "↑↓/PgUp/PgDn scroll · ← list · Esc close")}`, width),
			this.border(width),
			truncateToWidth(`${this.theme.bold(job.name)}  ${this.theme.fg(job.status === "completed" ? "success" : job.status === "running" ? "warning" : "muted", job.status)}`, width),
			truncateToWidth(`Model: ${job.route ? displayModel(job.route) : "routing"} · Thinking: ${job.route?.effort ?? "auto"} · Context: ${job.route?.contextMode ?? "auto"}`, width),
			truncateToWidth(`Permission: ${job.route?.permission ?? "auto"} · Duration: ${formatDuration(job)}`, width),
			...wrapTextWithAnsi(`${this.theme.fg("muted", "Task:")} ${job.task}`, width),
			this.border(width),
		];
		const output = (job.liveOutput || job.output || job.progress.join("\n") || "Waiting for output…").replace(/\r/g, "");
		const outputLines = output.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", width));
		const viewport = 18;
		const maxScroll = Math.max(0, outputLines.length - viewport);
		if (this.scroll === Number.MAX_SAFE_INTEGER) this.scroll = maxScroll;
		this.scroll = Math.min(this.scroll, maxScroll);
		const visible = outputLines.slice(this.scroll, this.scroll + viewport);
		const rangeStart = outputLines.length ? Math.min(outputLines.length, this.scroll + 1) : 0;
		const footer = this.theme.fg("dim", `output ${rangeStart}-${Math.min(outputLines.length, this.scroll + viewport)}/${outputLines.length}${job.status === "running" ? " · live" : ""}`);
		return [...header, ...visible.map((line) => truncateToWidth(line, width)), this.border(width), truncateToWidth(footer, width)];
	}
}

const ComplexitySchema = StringEnum(["auto", "simple", "medium", "complex", "critical"] as const, {
	description: "Task complexity override. Default auto.",
	default: "auto",
});
const EffortSchema = StringEnum(["auto", ...THINKING_LEVELS] as const, {
	description: "Thinking effort override. Default auto.",
	default: "auto",
});
const ContextModeSchema = StringEnum(["auto", "isolated", "selected", "summary", "full"] as const, {
	description: "Parent-context inheritance strategy. Default auto.",
	default: "auto",
});
const PermissionSchema = StringEnum(["auto", "read-only", "workspace-write"] as const, {
	description: "Workspace permission override. Default auto.",
	default: "auto",
});

const DelegateParams = Type.Object({
	task: Type.String({ description: "Concrete, bounded, self-contained task for the sub-agent." }),
	taskName: Type.Optional(Type.String({ description: "Short snake_case task name shown in the agent tree." })),
	expectedOutput: Type.Optional(Type.String({ description: "Acceptance criteria or exact expected result." })),
	contextFiles: Type.Optional(Type.Array(Type.String(), { description: "Relevant file or directory paths only." })),
	contextNotes: Type.Optional(Type.String({ description: "Specific decisions or constraints the worker needs." })),
	writeScope: Type.Optional(Type.Array(Type.String(), { description: "Files/directories this worker may modify. Disjoint scopes can run concurrently." })),
	model: Type.Optional(Type.String({ description: 'Model override as provider/model. Default "auto".', default: "auto" })),
	effort: Type.Optional(EffortSchema),
	complexity: Type.Optional(ComplexitySchema),
	contextMode: Type.Optional(ContextModeSchema),
	permission: Type.Optional(PermissionSchema),
	cwd: Type.Optional(Type.String({ description: "Working directory. Defaults to the parent cwd." })),
});

export default function smartSubagents(pi: ExtensionAPI) {
	const jobs = new Map<string, Job>();
	const queue: string[] = [];
	let latestCtx: ExtensionContext | undefined;
	let shuttingDown = false;
	let sequence = 0;
	let uiExpiryTimer: ReturnType<typeof setTimeout> | undefined;
	let agentBrowserRenderTimer: ReturnType<typeof setTimeout> | undefined;
	let agentBrowserOpen = false;
	let agentBrowserRequestRender: (() => void) | undefined;
	const deliveredCompletionIds = new Set<string>();
	const deferredCompletionMessages: Array<{ content: string; details: CompletionDetails }> = [];
	let parentAgentActive = false;

	const getVisibleJobs = () => {
		const now = Date.now();
		return [...jobs.values()].filter((job) => !FINAL_STATUSES.has(job.status) || !job.finishedAt || now - job.finishedAt < COMPLETED_JOB_HOLD_MS);
	};

	const openAgentBrowser = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || agentBrowserOpen || getVisibleJobs().length === 0) return;
		agentBrowserOpen = true;
		void ctx.ui.custom<void>(
			(tui, theme, _keybindings, done) => {
				agentBrowserRequestRender = () => tui.requestRender();
				return new AgentBrowser(getVisibleJobs, theme, () => {
					agentBrowserOpen = false;
					agentBrowserRequestRender = undefined;
					done();
				}, () => tui.requestRender());
			},
			{ overlay: true, overlayOptions: { width: "88%", maxHeight: "82%", anchor: "bottom-center", margin: 1 } },
		).finally(() => {
			agentBrowserOpen = false;
			agentBrowserRequestRender = undefined;
		});
	};

	const refreshAgentBrowser = () => {
		if (!agentBrowserRequestRender || agentBrowserRenderTimer) return;
		agentBrowserRenderTimer = setTimeout(() => {
			agentBrowserRenderTimer = undefined;
			agentBrowserRequestRender?.();
		}, 50);
		agentBrowserRenderTimer.unref?.();
	};

	const updateUi = () => {
		const ctx = latestCtx;
		if (!ctx?.hasUI) return;
		if (uiExpiryTimer) {
			clearTimeout(uiExpiryTimer);
			uiExpiryTimer = undefined;
		}
		const now = Date.now();
		const all = [...jobs.values()]
			.filter((job) => !FINAL_STATUSES.has(job.status) || !job.finishedAt || now - job.finishedAt < COMPLETED_JOB_HOLD_MS)
			.sort((a, b) => {
			const aFinal = FINAL_STATUSES.has(a.status) ? 1 : 0;
			const bFinal = FINAL_STATUSES.has(b.status) ? 1 : 0;
			return aFinal - bFinal || b.createdAt - a.createdAt;
		});
		if (all.length === 0) {
			ctx.ui.setWidget("smart-subagents", undefined);
			ctx.ui.setStatus("smart-subagents", undefined);
			return;
		}
		const config = all[0]?.config ?? loadConfig();
		const visible = all.slice(0, config.maxRecentJobs);
		const lines = ["Sub Agents"];
		visible.forEach((job, index) => {
			const last = index === visible.length - 1;
			const branch = last ? "└─" : "├─";
			const child = last ? "  " : "│ ";
			const statusIcon = job.status === "completed" ? "✓" : job.status === "failed" ? "✗" : job.status === "stopped" ? "■" : job.status === "queued" ? "○" : "●";
			lines.push(`${branch} ${job.name} ${statusIcon} ${job.status} · ${formatDuration(job)}`);
			if (job.route) {
				lines.push(`${child} model: ${displayModel(job.route)} · thinking: ${job.route.effort}`);
				lines.push(`${child} context: ${job.route.contextMode} · permission: ${job.route.permission}`);
			} else {
				lines.push(`${child} selecting model, thinking and context...`);
			}
		});
		ctx.ui.setWidget("smart-subagents", lines, { placement: "aboveEditor" });
		const active = all.filter((job) => job.status === "running").length;
		const queued = all.filter((job) => job.status === "queued" || job.status === "routing").length;
		ctx.ui.setStatus(
			"smart-subagents",
			active || queued ? ctx.ui.theme.fg("accent", `agents:${active} running${queued ? `/${queued} queued` : ""}`) : undefined,
		);
		const expiries = all
			.filter((job) => FINAL_STATUSES.has(job.status) && job.finishedAt)
			.map((job) => job.finishedAt! + COMPLETED_JOB_HOLD_MS)
			.filter((expiresAt) => expiresAt > now);
		if (expiries.length > 0) {
			uiExpiryTimer = setTimeout(() => {
				uiExpiryTimer = undefined;
				updateUi();
			}, Math.max(1, Math.min(...expiries) - now));
			uiExpiryTimer.unref?.();
		}
	};

	const appendState = (job: Job) => {
		try {
			pi.appendEntry("smart-subagent-state", snapshot(job));
		} catch {
			// Session may have been replaced while a process was shutting down.
		}
	};

	const lifecyclePayload = (event: LifecycleEvent, job: Job) => ({
		event,
		timestamp: Date.now(),
		job: snapshot(job),
	});

	const runShellHooks = (event: LifecycleEvent, job: Job) => {
		const commands = job.config.hooks[event] ?? [];
		if (commands.length === 0) return;
		const payload = JSON.stringify(lifecyclePayload(event, job));
		for (const command of commands) {
			try {
				const hook = spawn("/bin/sh", ["-lc", command], {
					cwd: job.cwd,
					env: {
						...process.env,
						PI_SUBAGENT_EVENT: event,
						PI_SUBAGENT_ID: job.id,
						PI_SUBAGENT_NAME: job.name,
						PI_SUBAGENT_MODEL: job.route?.modelRef ?? "",
						PI_SUBAGENT_EFFORT: job.route?.effort ?? "",
					},
					stdio: ["pipe", "ignore", "ignore"],
				});
				hook.stdin?.end(payload);
				const timeout = setTimeout(() => hook.kill("SIGTERM"), 30000);
				timeout.unref?.();
				hook.on("close", () => clearTimeout(timeout));
			} catch {
				// Hooks are observational and must not break result delivery.
			}
		}
	};

	const emitLifecycle = (event: LifecycleEvent, job: Job) => {
		try {
			pi.events.emit(`smart-subagent:${event}`, lifecyclePayload(event, job));
		} catch {
			// Event consumers are optional.
		}
		runShellHooks(event, job);
	};

	const recordProgress = (job: Job, message: string) => {
		const clean = message.replace(/\s+/g, " ").trim();
		if (!clean) return;
		job.progress.push(clean.length > 120 ? `${clean.slice(0, 120)}…` : clean);
		if (job.progress.length > PROGRESS_ITEMS_LIMIT) job.progress.splice(0, job.progress.length - PROGRESS_ITEMS_LIMIT);
		updateUi();
		const now = Date.now();
		if (now - job.lastProgressHookAt >= 2000) {
			job.lastProgressHookAt = now;
			emitLifecycle("progress", job);
		}
	};

	const writeRunResult = async (job: Job) => {
		if (!job.logPath) return;
		try {
			await fs.promises.writeFile(
				job.logPath,
				JSON.stringify(
					{
						...snapshot(job),
						output: job.output,
						stderr: job.stderr,
						contextPath: job.contextPath,
					},
					null,
					2,
				),
				{ encoding: "utf8", mode: 0o600 },
			);
		} catch {
			// The completion message still carries the result.
		}
	};

	const deliverCompletion = (event: "completed" | "failed", job: Job) => {
		if (shuttingDown || deliveredCompletionIds.has(job.id)) return;
		const route = job.route!;
		const output = truncateUtf8(job.output || job.error || job.stderr || "(no output)", RESULT_OUTPUT_LIMIT);
		const changed = job.changedFiles.length > 0 ? job.changedFiles.map((file) => `- ${file}`).join("\n") : "- None detected";
		const content = [
			`[Sub-agent lifecycle update — continue the original task]`,
			`Sub-agent ${event} event`,
			`Agent: ${job.name} (${job.id})`,
			`Model: ${route.provider}/${route.modelId}`,
			`Thinking: ${route.effort}`,
			`Context: ${route.contextMode}`,
			`Permission: ${route.permission}`,
			`Changed files:\n${changed}`,
			`Run log: ${job.logPath ?? "not saved"}`,
			"",
			"Result:",
			output,
			"",
			"This is lifecycle context for the existing task, not a new user task. Integrate it and continue the original task unless the user explicitly cancels or replaces that task.",
		].join("\n");
		const details: CompletionDetails = { event, job: snapshot(job) };
		try {
			if (parentAgentActive) {
				deferredCompletionMessages.push({ content, details });
			} else {
				pi.sendMessage<CompletionDetails>(
					{ customType: "smart-subagent-completion", content, display: true, details },
					{ triggerTurn: true, deliverAs: "followUp" },
				);
			}
			deliveredCompletionIds.add(job.id);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			latestCtx?.ui.notify(`Could not queue result from ${job.name}: ${reason}. Run log: ${job.logPath ?? "not saved"}`, "error");
		}
	};

	let pumpQueue: () => void;

	const finalizeJob = async (
		job: Job,
		status: "completed" | "failed" | "stopped",
		exitCode: number,
		error?: string,
	) => {
		if (FINAL_STATUSES.has(job.status)) return;
		job.status = status;
		job.exitCode = exitCode;
		job.finishedAt = Date.now();
		if (error) job.error = error;
		job.process = undefined;
		if (!shuttingDown) {
			appendState(job);
			updateUi();
			// Completion delivery is the critical path. Queue it before observational
			// hooks and disk I/O so the parent can react at its next safe boundary.
			if (status === "completed" || status === "failed") deliverCompletion(status, job);
			emitLifecycle(status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped", job);
			void writeRunResult(job);
			pumpQueue();
		}
		else {
			await writeRunResult(job);
		}
	};

	const appendLiveOutput = (job: Job, text: string) => {
		if (!text) return;
		job.liveOutput += text;
		if (job.liveOutput.length > LIVE_OUTPUT_LIMIT) job.liveOutput = job.liveOutput.slice(-LIVE_OUTPUT_LIMIT);
		refreshAgentBrowser();
	};

	const parseChildEvent = (job: Job, line: string) => {
		if (!line.trim()) return;
		let event: any;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}
		if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
			appendLiveOutput(job, event.assistantMessageEvent.delta ?? "");
			return;
		}
		if (event.type === "tool_execution_start") {
			const args = event.args ? ` ${typeof event.args === "string" ? event.args : JSON.stringify(event.args)}` : "";
			recordProgress(job, `tool: ${event.toolName ?? "unknown"}`);
			appendLiveOutput(job, `\n▶ ${event.toolName ?? "tool"}${args}\n`);
			return;
		}
		if (event.type === "tool_execution_update") {
			const update = textFromContent(event.partialResult?.content ?? event.content);
			if (update) appendLiveOutput(job, update);
			return;
		}
		if (event.type === "tool_execution_end") {
			const result = textFromContent(event.result?.content ?? event.content);
			if (result) appendLiveOutput(job, `${result}\n`);
			appendLiveOutput(job, `■ ${event.toolName ?? "tool"}${event.isError ? " failed" : " completed"}\n`);
			return;
		}
		if (event.type !== "message_end" || !event.message || event.message.role !== "assistant") return;
		const message = event.message;
		job.usage.turns += 1;
		if (message.usage) {
			job.usage.input += message.usage.input ?? 0;
			job.usage.output += message.usage.output ?? 0;
			job.usage.cacheRead += message.usage.cacheRead ?? 0;
			job.usage.cacheWrite += message.usage.cacheWrite ?? 0;
			job.usage.cost += message.usage.cost?.total ?? 0;
		}
		if (message.stopReason) (job as any).stopReason = message.stopReason;
		if (message.errorMessage) job.error = message.errorMessage;
		const textParts: string[] = [];
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
			if (part.type === "toolCall") {
				recordProgress(job, `tool: ${part.name}`);
				appendLiveOutput(job, `\n▶ ${part.name} ${JSON.stringify(part.arguments ?? {})}\n`);
				if ((part.name === "edit" || part.name === "write") && part.arguments) {
					const file = part.arguments.path ?? part.arguments.file_path;
					if (typeof file === "string" && !job.changedFiles.includes(file)) job.changedFiles.push(file);
				}
			}
		}
		const text = textParts.join("\n").trim();
		if (text) {
			job.output = text;
			if (!job.liveOutput.endsWith(text)) appendLiveOutput(job, `${job.liveOutput ? "\n" : ""}${text}`);
			recordProgress(job, text);
		}
	};

	const startJob = (job: Job) => {
		if (!job.route || !job.contextPath || shuttingDown || job.status === "stopped") return;
		try {
			fs.writeFileSync(
				job.contextPath,
				buildContextPacket(job, job.parentConversation, job.contextNotes),
				{ encoding: "utf8", mode: 0o600 },
			);
		} catch (error) {
			void finalizeJob(job, "failed", 1, error instanceof Error ? error.message : String(error));
			return;
		}
		if (!job.attemptedModels.includes(job.route.modelRef)) job.attemptedModels.push(job.route.modelRef);
		const tools = job.route.permission === "read-only"
			? "read,grep,find,ls"
			: "read,bash,edit,write,grep,find,ls";
		const prompt = [
			`# Delegated task: ${job.name}`,
			job.task,
			job.expectedOutput ? `\n## Expected output / acceptance criteria\n${job.expectedOutput}` : "",
		].join("\n");
		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--no-extensions",
			"--model", job.route.modelRef,
			"--thinking", job.route.effort,
			"--tools", tools,
			"--append-system-prompt", job.contextPath,
			prompt,
		];
		const invocation = getPiInvocation(args);
		job.status = "running";
		job.startedAt = Date.now();
		appendState(job);
		emitLifecycle("started", job);
		updateUi();
		try {
			const child = spawn(invocation.command, invocation.args, {
				cwd: job.cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SMART_SUBAGENT_ID: job.id,
					PI_SMART_SUBAGENT_NAME: job.name,
					PI_SMART_SUBAGENT_PARENT_SESSION: latestCtx?.sessionManager.getSessionId() ?? "",
				},
			});
			job.process = child;
			child.stdout?.on("data", (data) => {
				job.stdoutBuffer += data.toString();
				const lines = job.stdoutBuffer.split("\n");
				job.stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) parseChildEvent(job, line);
			});
			child.stderr?.on("data", (data) => {
				job.stderr = `${job.stderr}${data.toString()}`.slice(-STDERR_LIMIT);
			});
			child.on("error", (error) => {
				void finalizeJob(job, "failed", 1, error.message);
			});
			child.on("close", (code) => {
				if (job.stdoutBuffer.trim()) parseChildEvent(job, job.stdoutBuffer);
				job.stdoutBuffer = "";
				if (shuttingDown) {
					job.status = "stopped";
					return;
				}
				if (job.stopRequested) {
					void finalizeJob(job, "stopped", code ?? 143, "Stopped by user or session shutdown.");
					return;
				}
				const stopReason = (job as any).stopReason;
				const failed = (code ?? 0) !== 0 || stopReason === "error" || stopReason === "aborted";
				const failureText = `${job.error ?? ""}\n${job.stderr}`;
				const unsupportedModel = /model[_ ]not[_ ]supported|unsupported model|requested model is not supported/i.test(failureText);
				if (failed && unsupportedModel && job.fallbackRoutes.length > 0) {
					const previousModel = job.route?.modelRef ?? "unknown";
					job.route = job.fallbackRoutes.shift();
					job.status = "queued";
					job.process = undefined;
					job.startedAt = undefined;
					job.output = undefined;
					job.error = undefined;
					job.stderr = "";
					(job as any).stopReason = undefined;
					recordProgress(job, `model ${previousModel} unsupported; retrying with ${job.route?.modelRef}`);
					queue.push(job.id);
					appendState(job);
					pumpQueue();
					return;
				}
				void finalizeJob(
					job,
					failed ? "failed" : "completed",
					code ?? 0,
					failed ? job.error || job.stderr || `Child exited with code ${code ?? 1}` : undefined,
				);
			});
		} catch (error) {
			void finalizeJob(job, "failed", 1, error instanceof Error ? error.message : String(error));
		}
	};

	const canStart = (job: Job): boolean => {
		const running = [...jobs.values()].filter((candidate) => candidate.status === "running");
		if (running.length >= job.config.maxConcurrent) return false;
		if (job.route?.permission !== "workspace-write") return true;
		for (const other of running) {
			if (other.route?.permission !== "workspace-write") continue;
			if (scopesOverlap(job.writeScope, other.writeScope)) return false;
		}
		return true;
	};

	pumpQueue = () => {
		if (shuttingDown) return;
		while (true) {
			const index = queue.findIndex((id) => {
				const job = jobs.get(id);
				return Boolean(job && job.status === "queued" && canStart(job));
			});
			if (index < 0) return;
			const [id] = queue.splice(index, 1);
			const job = jobs.get(id);
			if (job) startJob(job);
		}
	};

	const stopJob = (job: Job) => {
		if (FINAL_STATUSES.has(job.status)) return false;
		job.stopRequested = true;
		if (job.status === "queued" || job.status === "routing") {
			const index = queue.indexOf(job.id);
			if (index >= 0) queue.splice(index, 1);
			void finalizeJob(job, "stopped", 0, "Stopped before execution.");
			return true;
		}
		job.process?.kill("SIGTERM");
		const processRef = job.process;
		const timeout = setTimeout(() => processRef?.kill("SIGKILL"), 5000);
		timeout.unref?.();
		return true;
	};

	pi.registerMessageRenderer<CompletionDetails>(
		"smart-subagent-completion",
		(message, { expanded, outputPad }, theme) => {
			const details = message.details;
			const fallbackContent = typeof message.content === "string" ? message.content : textFromContent(message.content);
			const route = details?.job.route;
			if (!details || !route) return new Text(fallbackContent, outputPad, 0);
			const job = details.job;
			const success = details.event === "completed";
			const icon = success ? theme.fg("success", "✓") : theme.fg("error", "✗");
			const box = new Box(outputPad, 1, (text) => theme.bg("customMessageBg", text));
			box.addChild(new Text(`${icon} ${theme.bold(job.name)} ${theme.fg(success ? "success" : "error", details.event)}`, 0, 0));
			box.addChild(new Text(theme.fg("muted", `model: ${displayModel(route)} · thinking: ${route.effort} · ${formatDuration(job)}`), 0, 0));
			box.addChild(new Text(theme.fg("muted", `context: ${route.contextMode} · permission: ${route.permission}`), 0, 0));
			if (job.changedFiles.length > 0) box.addChild(new Text(theme.fg("muted", `changed: ${job.changedFiles.join(", ")}`), 0, 0));
			box.addChild(new Spacer(1));
			const output = job.output || job.error || "(no output)";
			if (expanded) {
				box.addChild(new Markdown(output, 0, 0, getMarkdownTheme()));
				if (job.logPath) {
					box.addChild(new Spacer(1));
					box.addChild(new Text(theme.fg("dim", `run log: ${job.logPath}`), 0, 0));
				}
			} else {
				const preview = output.split("\n").slice(0, 6).join("\n");
				box.addChild(new Text(theme.fg("toolOutput", preview.length > 1000 ? `${preview.slice(0, 1000)}…` : preview), 0, 0));
				box.addChild(new Text(theme.fg("dim", "Ctrl+O to expand"), 0, 0));
			}
			return box;
		},
	);

	pi.registerShortcut("down", {
		description: "Inspect running sub-agents",
		override: true,
		handler: async (ctx) => openAgentBrowser(ctx),
	});

	pi.registerTool({
		name: "delegate_subagent",
		label: "Delegate Sub Agent",
		description: "Dispatch a bounded task to an asynchronous sub-agent. Model, thinking effort, context inheritance and permission default to auto. The call returns after dispatch; completion is delivered automatically as a lifecycle message, so never poll or repeatedly check status.",
		promptSnippet: "Dispatch independent bounded work to an automatically routed background sub-agent",
		promptGuidelines: [
			"Use delegate_subagent for concrete independent work that can run concurrently with useful local work; keep immediate critical-path blockers local.",
			"Make every delegate_subagent task self-contained, provide exact contextFiles/contextNotes, and provide disjoint writeScope values for concurrent editing tasks.",
			"Do not poll after delegate_subagent. Completion or failure is automatically delivered through a hook-driven message that wakes the parent agent.",
			"After delegate_subagent dispatches, continue meaningful non-overlapping work or yield; do not duplicate the delegated task.",
		],
		parameters: DelegateParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			latestCtx = ctx;
			const config = loadConfig();
			const id = `sa-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
			const name = (params.taskName?.trim() || `task_${sequence}`)
				.toLowerCase()
				.replace(/[^a-z0-9_]+/g, "_")
				.replace(/^_+|_+$/g, "") || `task_${sequence}`;
			const job: Job = {
				id,
				name,
				task: params.task,
				expectedOutput: params.expectedOutput,
				status: "routing",
				contextFiles: [...(params.contextFiles ?? [])],
				writeScope: [...(params.writeScope ?? [])],
				cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
				createdAt: Date.now(),
				changedFiles: [],
				attemptedModels: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				progress: [],
				config,
				stdoutBuffer: "",
				liveOutput: "",
				stderr: "",
				stopRequested: false,
				lastProgressHookAt: 0,
				fallbackRoutes: [],
				parentConversation: "",
				contextNotes: params.contextNotes ?? "",
			};
			jobs.set(id, job);
			updateUi();
			onUpdate?.({
				content: [{ type: "text", text: `Routing ${name}: selecting model, thinking effort and context...` }],
				details: {
					job: snapshot(job),
					requested: {
						model: params.model ?? "auto",
						effort: params.effort ?? "auto",
						contextMode: params.contextMode ?? "auto",
						complexity: params.complexity ?? "auto",
						permission: params.permission ?? "auto",
					},
				} satisfies DispatchDetails,
			});

			try {
				if (signal?.aborted) throw new Error("Dispatch aborted before routing.");
				const routed = await classifyAndSummarize(ctx, params, config, signal);
				if (signal?.aborted) throw new Error("Dispatch aborted before spawn.");
				const models = ctx.modelRegistry.getAvailable();
				const availableRefs = models.map((model) => `${model.provider}/${model.id}`);
				const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
				const requestedModel = params.model ?? "auto";
				const candidateRefs = selectModelCandidates(
					availableRefs,
					currentRef,
					routed.decision.complexity,
					config,
					requestedModel,
				);
				if (candidateRefs.length === 0 && requestedModel !== "auto") {
					throw new Error(`Requested sub-agent model is not available: ${requestedModel}`);
				}
				if (candidateRefs.length === 0) throw new Error("No authenticated model is available for sub-agent routing.");
				const requestedEffort = (params.effort && params.effort !== "auto"
					? params.effort
					: config.routes[routed.decision.complexity].effort) as ThinkingLevel;
				const routeCandidates = candidateRefs.map((modelRef) => {
					const model = resolveAvailableModel(models, modelRef);
					if (!model) throw new Error(`Could not resolve routed model: ${modelRef}`);
					const effort = clampThinkingLevel(requestedEffort, getSupportedThinkingLevels(model).map(String));
					const [provider, ...modelParts] = modelRef.split("/");
					return {
						...routed.decision,
						modelRef,
						provider,
						modelId: modelParts.join("/"),
						modelName: model.name,
						providerName: ctx.modelRegistry.getProviderDisplayName(provider),
						effort,
					} satisfies RouteDecision;
				});
				const effectiveRoute = routeCandidates.shift();
				if (!effectiveRoute) throw new Error("Model routing produced no usable candidate.");
				job.route = effectiveRoute;
				job.fallbackRoutes = routeCandidates;
				job.parentConversation = routed.conversation;
				const runDir = path.join(RUNS_DIR, ctx.sessionManager.getSessionId(), id);
				await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 });
				job.contextPath = path.join(runDir, "context.md");
				job.logPath = path.join(runDir, "result.json");
				job.status = "queued";
				queue.push(job.id);
				appendState(job);
				pumpQueue();
				updateUi();
				const details: DispatchDetails = {
					job: snapshot(job),
					requested: {
						model: requestedModel,
						effort: params.effort ?? "auto",
						contextMode: params.contextMode ?? "auto",
						complexity: params.complexity ?? "auto",
						permission: params.permission ?? "auto",
					},
				};
				return {
					content: [
						{
							type: "text",
							text: [
								`Dispatched ${job.name} (${job.id}); status: ${job.status}.`,
								`Effective model: ${effectiveRoute.provider}/${effectiveRoute.modelId}`,
								`Thinking: ${effectiveRoute.effort}`,
								`Context: ${effectiveRoute.contextMode}`,
								`Permission: ${effectiveRoute.permission}`,
								`Reason: ${effectiveRoute.reason}`,
								"Completion will be delivered automatically. Do not poll.",
							].join("\n"),
						},
					],
					details,
					usage: routed.usage,
				};
			} catch (error) {
				job.status = "failed";
				job.finishedAt = Date.now();
				job.error = error instanceof Error ? error.message : String(error);
				appendState(job);
				emitLifecycle("failed", job);
				updateUi();
				throw error;
			}
		},

		renderCall(args, theme) {
			const name = args.taskName || "auto-named";
			const preview = args.task.length > 90 ? `${args.task.slice(0, 90)}…` : args.task;
			return new Text(
				`${theme.fg("toolTitle", theme.bold("delegate_subagent "))}${theme.fg("accent", name)}\n` +
				`${theme.fg("dim", preview)}\n` +
				`${theme.fg("muted", `requested: model=${args.model ?? "auto"} · thinking=${args.effort ?? "auto"} · context=${args.contextMode ?? "auto"}`)}`,
				0,
				0,
			);
		},

		renderResult(result, { isPartial }, theme) {
			const details = result.details as DispatchDetails | undefined;
			const job = details?.job;
			if (!job?.route) {
				return new Text(theme.fg("warning", isPartial ? "Selecting route…" : "Route unavailable"), 0, 0);
			}
			const route = job.route;
			const icon = job.status === "running" ? theme.fg("warning", "●") : job.status === "queued" ? theme.fg("muted", "○") : theme.fg("success", "✓");
			return new Text(
				[
					`${icon} ${theme.fg("accent", job.name)} ${theme.fg("muted", `[${job.status}]`)}`,
					`${theme.fg("muted", "Model: ")}${theme.fg("toolOutput", displayModel(route))}`,
					`${theme.fg("muted", "Thinking: ")}${theme.fg("toolOutput", route.effort)}`,
					`${theme.fg("muted", "Context: ")}${theme.fg("toolOutput", route.contextMode)}${theme.fg("dim", ` · ${job.contextFiles.length} explicit files`)}`,
					`${theme.fg("muted", "Permission: ")}${theme.fg("toolOutput", route.permission)}`,
					`${theme.fg("muted", "Reason: ")}${theme.fg("dim", route.reason)}`,
					`${theme.fg("dim", "Hook-driven completion enabled; no polling required.")}`,
				].join("\n"),
				0,
				0,
			);
		},
	});

	pi.registerCommand("agents", {
		description: "Inspect or manage smart sub-agents: /agents [open|stop <id|name>|clear|config]",
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const [action = "open", ...rest] = args.trim().split(/\s+/).filter(Boolean);
			if (action === "open" || action === "list") {
				if (getVisibleJobs().length === 0) ctx.ui.notify("No running or recently completed sub-agents", "info");
				else openAgentBrowser(ctx);
				return;
			}
			if (action === "stop") {
				const target = rest.join(" ");
				const job = [...jobs.values()].find((candidate) => candidate.id === target || candidate.name === target);
				if (!job) {
					ctx.ui.notify(`Sub-agent not found: ${target || "(missing target)"}`, "error");
					return;
				}
				ctx.ui.notify(stopJob(job) ? `Stopping ${job.name}` : `${job.name} is already ${job.status}`, "info");
				return;
			}
			if (action === "clear") {
				for (const [id, job] of jobs) if (FINAL_STATUSES.has(job.status)) jobs.delete(id);
				updateUi();
				ctx.ui.notify("Cleared completed sub-agents from the live tree", "info");
				return;
			}
			if (action === "config") {
				ctx.ui.notify(`Smart sub-agent config: ${CONFIG_PATH}`, "info");
				return;
			}
			ctx.ui.notify(`Unknown /agents action: ${action}`, "warning");
		},
	});

	pi.on("session_start", (_event, ctx) => {
		latestCtx = ctx;
		shuttingDown = false;
		updateUi();
	});

	pi.on("agent_start", () => {
		parentAgentActive = true;
	});

	pi.on("agent_end", () => {
		parentAgentActive = false;
		const completions = deferredCompletionMessages.splice(0);
		for (const completion of completions) {
			pi.sendMessage<CompletionDetails>(
				{ customType: "smart-subagent-completion", content: completion.content, display: true, details: completion.details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		}
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		if (uiExpiryTimer) {
			clearTimeout(uiExpiryTimer);
			uiExpiryTimer = undefined;
		}
		if (agentBrowserRenderTimer) {
			clearTimeout(agentBrowserRenderTimer);
			agentBrowserRenderTimer = undefined;
		}
		agentBrowserRequestRender = undefined;
		queue.splice(0, queue.length);
		for (const job of jobs.values()) {
			if (job.status === "running") {
				job.stopRequested = true;
				job.process?.kill("SIGTERM");
			}
		}
	});
}
