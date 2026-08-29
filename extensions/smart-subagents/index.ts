import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
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
import { Box, Container, Markdown, Spacer, Text, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { resolveAgentBrowserInput, type AgentBrowserKeybindings } from "./agent-browser-input.ts";
import { getPiInvocation } from "./pi-invocation.ts";
import {
	buildWorkerArgs,
	fetchFailureHint,
	mayFallbackAfterFailure,
	preflightWorkerProvider,
	resolveWorkerExtensions,
	type ResolvedWorkerExtension,
} from "./worker-bootstrap.ts";
import {
	ControlDispatcher,
	WebActivityRegistry,
} from "../web-activity/registry.ts";
import {
	createActivityWidgetOwner,
	releaseActivityWidgetSection,
	setActivityWidgetSection,
} from "../shared/activity-widget-stack.ts";
import { buildWebAgentsRecord, buildWebRuntimeRecord, isWebActivityStartCurrent } from "./web-record.ts";
import {
	applyFinalOutcome,
	classifyChildClose,
	createActivityRefreshLoop,
	createExecutionTimeout,
	shutdownJobs,
	terminateWithGrace,
	timeoutFailureMessage,
	writeJsonAtomically,
	type FinalOutcome,
	type StopRequestKind,
	type TerminationController,
	type TerminationReason,
} from "./lifecycle.ts";
import {
	DEFAULT_CONFIG,
	THINKING_LEVELS,
	buildModelListText,
	clampThinkingLevel,
	fallbackComplexity,
	fallbackPermission,
	mergeConfig,
	paginateModels,
	parseClassifierDecision,
	recentMessages,
	resolveModelProfile,
	scopesOverlap,
	selectModelCandidates,
	type ClassifierDecision,
	type Complexity,
	type ContextMode,
	type EligibleModelDescriptor,
	type ModelListOptions,
	type ModelProfilesConfig,
	type ParentMessage,
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
	signal?: string;
	terminationReason?: TerminationReason;
	timedOutAt?: number;
	timeoutEscalated?: boolean;
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
	stopRequest?: StopRequestKind;
	childStopReason?: string;
	executionTimeout?: ReturnType<typeof createExecutionTimeout>;
	stopEscalation?: TerminationController;
	resultWritePromise?: Promise<void>;
	lastProgressHookAt: number;
	lastOutputAt?: number;
	lastProgressAt?: number;
	timeoutAt?: number;
	fallbackRoutes: RouteDecision[];
	parentMessages: ParentMessage[];
	parentConversation: string;
	contextNotes: string;
	/** True once the worker emits any tool activity; disables automatic fallback. */
	toolActivitySeen: boolean;
	/** Trusted provider bootstrap files resolved before dispatch (fixed order). */
	workerExtensions: ResolvedWorkerExtension[];
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

interface ModelListDetails {
	scope: "session" | "all-authenticated";
	totalEligible: number;
	matched: number;
	shown: number;
	offset: number;
	nextOffset?: number;
	truncated: boolean;
	models: EligibleModelDescriptor[];
}

interface RouterResult {
	decision: ClassifierDecision;
	usage?: Usage;
	messages: ParentMessage[];
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

function collectParentMessages(ctx: ExtensionContext): ParentMessage[] {
	const messages: ParentMessage[] = [];
	for (const entry of ctx.sessionManager.getBranch() as any[]) {
		if (entry.type === "compaction" && typeof entry.summary === "string") {
			messages.push({ role: "assistant", text: `[Compaction summary]\n${entry.summary}` });
			continue;
		}
		if (entry.type !== "message" || !entry.message) continue;
		const role = entry.message.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textFromContent(entry.message.content).trim();
		if (text) messages.push({ role, text });
	}
	return messages;
}

function serializeMessages(messages: ParentMessage[]): string {
	return messages
		.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`)
		.join("\n\n");
}

function resolveAvailableModel(models: Model<any>[], reference: string): Model<any> | undefined {
	return models.find((model) => `${model.provider}/${model.id}` === reference);
}

function getEligibleModels(ctx: ExtensionContext): Model<any>[] {
	const available = ctx.modelRegistry.getAvailable();
	if (ctx.scopedModels.length === 0) return available;
	const scopedRefs = new Set(
		ctx.scopedModels.map(({ model }) => `${model.provider}/${model.id}`),
	);
	return available.filter((model) => scopedRefs.has(`${model.provider}/${model.id}`));
}

function describeEligibleModel(
	ctx: ExtensionContext,
	model: Model<any>,
	profiles: ModelProfilesConfig,
	currentRef: string | undefined,
): EligibleModelDescriptor {
	const ref = `${model.provider}/${model.id}`;
	const profile = resolveModelProfile(profiles, ref);
	return {
		ref,
		provider: model.provider,
		providerName: ctx.modelRegistry.getProviderDisplayName(model.provider),
		id: model.id,
		name: model.name,
		current: ref === currentRef,
		...profile,
		thinkingLevels: getSupportedThinkingLevels(model).map(String),
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		costInput: model.cost.input,
		costOutput: model.cost.output,
		costTiered: (model.cost.tiers?.length ?? 0) > 0,
	};
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
	const messages = collectParentMessages(ctx);
	const conversation = serializeMessages(messages);
	let decision = fallbackDecision(params.task, expectedOutput, contextNotes, config);
	let usage: Usage | undefined;
	const allRoutingFieldsExplicit = [params.complexity, params.contextMode, params.permission]
		.every((value) => Boolean(value) && value !== "auto");

	if (allRoutingFieldsExplicit && params.contextMode !== "summary") {
		decision.reason = "All routing fields were explicit; background advisor skipped.";
		decision.contextSummary = "";
	} else if (config.router.enabled) {
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
				`PARENT CONVERSATION:\n${conversation.slice(0, config.router.maxConversationChars) || "No parent conversation available"}`,
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
	}
	if (params.permission && params.permission !== "auto") {
		decision.permission = params.permission as PermissionMode;
	}
	decision.contextSummary = decision.contextSummary.slice(0, config.router.maxSummaryChars);
	return { decision, usage, messages, conversation };
}

function buildContextPacket(
	job: Job,
	messages: ParentMessage[],
	conversation: string,
	contextNotes: string,
): string {
	const route = job.route!;
	const selectedMessages = serializeMessages(recentMessages(messages, job.config.context.selectedMessages));
	const selectedContext = selectedMessages.length > job.config.context.maxSelectedChars
		? `[Earlier messages omitted]\n${selectedMessages.slice(-job.config.context.maxSelectedChars)}`
		: selectedMessages;
	let inheritedContext = "No parent conversation was inherited. Work only from the task and repository instructions.";
	if (route.contextMode === "selected") {
		inheritedContext = selectedContext || "No additional parent facts were selected.";
	} else if (route.contextMode === "summary") {
		inheritedContext = route.contextSummary || [
			"[Summary unavailable; fell back to the most recent parent messages]",
			selectedContext || "No parent conversation was available.",
		].join("\n");
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
		signal: job.signal,
		terminationReason: job.terminationReason,
		timedOutAt: job.timedOutAt,
		timeoutEscalated: job.timeoutEscalated,
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
		private readonly keybindings: AgentBrowserKeybindings,
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
		const action = resolveAgentBrowserInput(data, this.detail, this.keybindings, matchesKey);
		if (!action) return;
		if (action === "close") {
			this.done();
			return;
		}
		if (action === "back") {
			this.detail = false;
			this.scroll = 0;
			this.requestRender();
			return;
		}
		if (this.detail) {
			if (action === "line-up") this.scroll = Math.max(0, this.scroll - 1);
			else if (action === "line-down") this.scroll += 1;
			else if (action === "page-up") this.scroll = Math.max(0, this.scroll - 12);
			else if (action === "page-down") this.scroll += 12;
			else if (action === "top") this.scroll = 0;
			else if (action === "bottom") this.scroll = Number.MAX_SAFE_INTEGER;
			else return;
			this.requestRender();
			return;
		}

		const jobs = this.jobs();
		if (!jobs.length) return;
		if (action === "select-up") this.selected = (this.selected - 1 + jobs.length) % jobs.length;
		else if (action === "select-down") this.selected = (this.selected + 1) % jobs.length;
		else if (action === "inspect") {
			this.detail = true;
			this.scroll = Number.MAX_SAFE_INTEGER;
		} else return;
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
			truncateToWidth(`${this.theme.fg("accent", "Sub-agent detail")} ${this.theme.fg("dim", "↑↓ line · PgUp/PgDn or ⌥↑/⌥↓ page · Home/End · ← list · Esc close")}`, width),
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

const ListSubagentModelsParams = Type.Object({
	filter: Type.Optional(Type.String({ description: "Case-insensitive model, provider, or profile-note filter." })),
	tier: Type.Optional(StringEnum(["S", "A", "B", "C"] as const)),
	maxRows: Type.Optional(Type.Number({ description: "Maximum rows to return (1-50). Default 20." })),
	offset: Type.Optional(Type.Number({ description: "Zero-based pagination offset. Default 0." })),
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
	const activityWidgetOwner = createActivityWidgetOwner("subagents");
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
	let updateUi: () => void = () => {};
	// PI WEB activity registry state. Timers and dispatchers are only started
	// in session_start and cleared in session_shutdown.
	let webRegistry: WebActivityRegistry | undefined;
	let webDispatcher: ControlDispatcher | undefined;
	let webRuntimeId = "";
	let webGeneration = 0;
	let webControlToken = "";
	let webRuntimeStartedAt = 0;
	let webStartEpoch = 0;
	let webHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
	let webControlPollTimer: ReturnType<typeof setInterval> | undefined;
	let lastWebProgressFlushAt = 0;
	let webProgressDirty = false;
	const durationRefreshLoop = createActivityRefreshLoop({
		hasActiveJobs: () => Boolean(
			!shuttingDown &&
			latestCtx?.hasUI &&
			[...jobs.values()].some((job) => job.status === "routing" || job.status === "queued" || job.status === "running"),
		),
		onTick: () => updateUi(),
		intervalMs: 1000,
	});

	const getVisibleJobs = () => {
		const now = Date.now();
		return [...jobs.values()].filter((job) => !FINAL_STATUSES.has(job.status) || !job.finishedAt || now - job.finishedAt < COMPLETED_JOB_HOLD_MS);
	};

	const openAgentBrowser = (ctx: ExtensionContext) => {
		if (!ctx.hasUI || agentBrowserOpen || getVisibleJobs().length === 0) return;
		agentBrowserOpen = true;
		void ctx.ui.custom<void>(
			(tui, theme, keybindings, done) => {
				agentBrowserRequestRender = () => tui.requestRender();
				return new AgentBrowser(getVisibleJobs, theme, keybindings, () => {
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

	updateUi = () => {
		durationRefreshLoop.sync();
		const ctx = latestCtx;
		if (!ctx?.hasUI || shuttingDown) return;
		refreshAgentBrowser();
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
			setActivityWidgetSection(ctx.ui, activityWidgetOwner);
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
		setActivityWidgetSection(ctx.ui, activityWidgetOwner, lines);
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
		flushWebAgents();
	};

	const flushWebAgents = (): Promise<boolean> | undefined => {
		webProgressDirty = false;
		const registry = webRegistry;
		const ctx = latestCtx;
		if (!registry || !ctx) return undefined;
		const record = buildWebAgentsRecord([...jobs.values()], queue, {
			sessionId: ctx.sessionManager.getSessionId(),
			runtimeId: webRuntimeId,
			generation: webGeneration,
		});
		return registry.write("agents", record);
	};

	const flushWebRuntime = (state: "active" | "shutdown" = "active"): Promise<boolean> | undefined => {
		const registry = webRegistry;
		const ctx = latestCtx;
		if (!registry || !ctx) return undefined;
		const all = [...jobs.values()];
		const record = buildWebRuntimeRecord(
			{
				sessionId: ctx.sessionManager.getSessionId(),
				runtimeId: webRuntimeId,
				generation: webGeneration,
				controlToken: webControlToken,
			},
			state,
			{
				startedAt: webRuntimeStartedAt,
				total: all.length,
				active: all.filter((job) => job.status === "routing" || job.status === "queued" || job.status === "running").length,
			},
		);
		return registry.write("runtime", record);
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
		job.lastProgressAt = now;
		// Registry progress flush is throttled to at most once per 2s;
		// deferred updates are picked up by the next flush or heartbeat.
		webProgressDirty = true;
		if (now - lastWebProgressFlushAt >= 2000) {
			lastWebProgressFlushAt = now;
			flushWebAgents();
		}
		if (now - job.lastProgressHookAt >= 2000) {
			job.lastProgressHookAt = now;
			emitLifecycle("progress", job);
		}
	};

	const writeRunResult = async (job: Job) => {
		if (!job.logPath) return;
		try {
			await writeJsonAtomically(job.logPath, {
				...snapshot(job),
				output: job.output,
				stderr: job.stderr,
				contextPath: job.contextPath,
			});
		} catch {
			// Lifecycle finalization must remain safe even if the run directory is unavailable.
		}
	};

	const persistRunResult = (job: Job): Promise<void> => {
		job.resultWritePromise ??= writeRunResult(job);
		return job.resultWritePromise;
	};

	const deliverCompletion = (event: "completed" | "failed", job: Job) => {
		if (shuttingDown || deliveredCompletionIds.has(job.id)) return;
		const route = job.route!;
		const primaryResult = event === "failed"
			? job.error || job.stderr || job.output
			: job.output || job.error || job.stderr;
		const output = truncateUtf8(primaryResult || "(no output)", RESULT_OUTPUT_LIMIT);
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

	const clearJobTimers = (job: Job) => {
		job.executionTimeout?.cancel();
		job.executionTimeout = undefined;
		job.stopEscalation?.cancel();
		job.stopEscalation = undefined;
	};

	const finalizeJob = async (
		job: Job,
		outcome: FinalOutcome,
		options: { persistenceOnly?: boolean } = {},
	): Promise<boolean> => {
		if (!applyFinalOutcome(job, outcome)) return false;
		clearJobTimers(job);
		// appendEntry is attempted while session_shutdown still owns the old session;
		// result.json is the independent durable fallback if that session is stale.
		appendState(job);
		if (options.persistenceOnly || shuttingDown) {
			await persistRunResult(job);
			return true;
		}
		updateUi();
		// Completion delivery is the critical path. Queue it before observational
		// hooks and disk I/O so the parent can react at its next safe boundary.
		if ((outcome.status === "completed" || outcome.status === "failed") && job.route) {
			deliverCompletion(outcome.status, job);
		}
		emitLifecycle(outcome.status === "completed" ? "completed" : outcome.status === "failed" ? "failed" : "stopped", job);
		void persistRunResult(job);
		pumpQueue();
		return true;
	};

	const appendLiveOutput = (job: Job, text: string) => {
		if (!text) return;
		job.liveOutput += text;
		if (job.liveOutput.length > LIVE_OUTPUT_LIMIT) job.liveOutput = job.liveOutput.slice(-LIVE_OUTPUT_LIMIT);
		job.lastOutputAt = Date.now();
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
			job.toolActivitySeen = true;
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
		if (message.stopReason) job.childStopReason = message.stopReason;
		if (message.errorMessage) job.error = message.errorMessage;
		const textParts: string[] = [];
		for (const part of Array.isArray(message.content) ? message.content : []) {
			if (part.type === "text" && typeof part.text === "string") textParts.push(part.text);
			if (part.type === "toolCall") {
				job.toolActivitySeen = true;
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
		if (!job.route || !job.contextPath || shuttingDown || FINAL_STATUSES.has(job.status)) return;
		try {
			fs.writeFileSync(
				job.contextPath,
				buildContextPacket(job, job.parentMessages, job.parentConversation, job.contextNotes),
				{ encoding: "utf8", mode: 0o600 },
			);
		} catch (error) {
			void finalizeJob(job, {
				status: "failed",
				exitCode: 1,
				terminationReason: "spawn_error",
				error: error instanceof Error ? error.message : String(error),
			});
			return;
		}
		if (!job.attemptedModels.includes(job.route.modelRef)) job.attemptedModels.push(job.route.modelRef);
		const tools = job.route.permission === "read-only"
			? "read,grep,find,ls,web_search"
			: "read,bash,edit,write,grep,find,ls,web_search";
		const prompt = [
			`# Delegated task: ${job.name}`,
			job.task,
			job.expectedOutput ? `\n## Expected output / acceptance criteria\n${job.expectedOutput}` : "",
		].join("\n");
		const args = buildWorkerArgs({
			modelRef: job.route.modelRef,
			effort: job.route.effort,
			tools,
			contextPath: job.contextPath,
			prompt,
			extensions: job.workerExtensions,
		});
		const invocation = getPiInvocation(args);
		job.status = "running";
		job.startedAt = Date.now();
		job.timeoutAt = job.startedAt + job.config.execution.hardTimeoutMs;
		appendState(job);
		emitLifecycle("started", job);
		updateUi();
		try {
			latestCtx?.ui.notify(
				`🤖 Sub-agent ${job.name} started · ${job.route.modelName} · ${job.route.effort} · ${job.route.contextMode} · ${job.route.permission}`,
				"info",
			);
		} catch {
			// Notifications are best-effort; PI WEB clients may ignore them.
		}
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
				if (FINAL_STATUSES.has(job.status)) return;
				job.stdoutBuffer += data.toString();
				const lines = job.stdoutBuffer.split("\n");
				job.stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) parseChildEvent(job, line);
			});
			child.stderr?.on("data", (data) => {
				if (FINAL_STATUSES.has(job.status)) return;
				job.stderr = `${job.stderr}${data.toString()}`.slice(-STDERR_LIMIT);
			});
			child.on("error", (error) => {
				if (FINAL_STATUSES.has(job.status)) return;
				if (job.stopRequest || job.timedOutAt) {
					// kill() can emit `error`; keep the grace escalation armed instead of
					// finalizing early and accidentally cancelling the pending SIGKILL.
					job.stderr = `${job.stderr}\nprocess signalling error: ${error.message}`.trim().slice(-STDERR_LIMIT);
					return;
				}
				void finalizeJob(job, {
					status: "failed",
					exitCode: 1,
					terminationReason: "spawn_error",
					error: error.message,
				});
			});
			child.on("close", (code, signal) => {
				if (FINAL_STATUSES.has(job.status)) {
					job.stdoutBuffer = "";
					return;
				}
				if (job.stdoutBuffer.trim()) parseChildEvent(job, job.stdoutBuffer);
				job.stdoutBuffer = "";
				job.executionTimeout?.cancel();
				job.executionTimeout = undefined;
				job.stopEscalation?.cancel();
				job.stopEscalation = undefined;
				const outcome = classifyChildClose({
					code,
					signal,
					stopRequest: job.stopRequest,
					timedOut: Boolean(job.timedOutAt),
					timeoutEscalated: job.timeoutEscalated,
					hardTimeoutMs: job.config.execution.hardTimeoutMs,
					terminateGraceMs: job.config.execution.terminateGraceMs,
					childStopReason: job.childStopReason,
					error: job.error,
					stderr: job.stderr,
				});
				const failureText = `${job.error ?? ""}\n${job.stderr}`;
				// The unsupported-model fallback is the only automatic retry, and it
				// never runs after tool activity or file edits (possible side
				// effects). A generic fetch failure is not an unsupported model.
				const fallbackAllowed = mayFallbackAfterFailure({
					terminationReason: outcome.terminationReason,
					failureText,
					toolActivitySeen: job.toolActivitySeen,
					changedFileCount: job.changedFiles.length,
					fallbackRouteCount: job.fallbackRoutes.length,
				});
				if (fallbackAllowed) {
					const previousModel = job.route?.modelRef ?? "unknown";
					job.route = job.fallbackRoutes.shift();
					job.status = "queued";
					job.process = undefined;
					job.startedAt = undefined;
					job.output = undefined;
					job.error = undefined;
					job.stderr = "";
					job.childStopReason = undefined;
					job.timedOutAt = undefined;
					job.timeoutEscalated = undefined;
					job.timeoutAt = undefined;
					job.toolActivitySeen = false;
					recordProgress(job, `model ${previousModel} unsupported; retrying with ${job.route?.modelRef}`);
					queue.push(job.id);
					appendState(job);
					pumpQueue();
					return;
				}
				// Bounded diagnostic when the worker died before any tool activity
				// with a generic transport/fetch failure (never prints secrets).
				if (!job.toolActivitySeen) {
					const hint = fetchFailureHint(failureText);
					if (hint) outcome.error = outcome.error ? `${outcome.error}\n\n${hint}` : hint;
				}
				void finalizeJob(job, outcome);
			});
			job.executionTimeout = createExecutionTimeout({
				process: child,
				timeoutMs: job.config.execution.hardTimeoutMs,
				graceMs: job.config.execution.terminateGraceMs,
				onTimeout: () => {
					if (FINAL_STATUSES.has(job.status)) return;
					job.timedOutAt = Date.now();
					job.timeoutEscalated = false;
					job.error = timeoutFailureMessage(
						job.config.execution.hardTimeoutMs,
						job.config.execution.terminateGraceMs,
						false,
					);
					recordProgress(job, "hard execution timeout reached; terminating worker");
					appendState(job);
				},
				onEscalate: () => {
					if (FINAL_STATUSES.has(job.status)) return;
					job.timeoutEscalated = true;
					void finalizeJob(job, {
						status: "failed",
						exitCode: 137,
						signal: "SIGKILL",
						terminationReason: "timed_out",
						error: timeoutFailureMessage(
							job.config.execution.hardTimeoutMs,
							job.config.execution.terminateGraceMs,
							true,
						),
					});
				},
			});
		} catch (error) {
			void finalizeJob(job, {
				status: "failed",
				exitCode: 1,
				terminationReason: "spawn_error",
				error: error instanceof Error ? error.message : String(error),
			});
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
		if (FINAL_STATUSES.has(job.status) || job.stopRequest === "user" || Boolean(job.timedOutAt)) return false;
		job.stopRequest = "user";
		job.executionTimeout?.cancel();
		job.executionTimeout = undefined;
		if (job.status === "queued" || job.status === "routing") {
			const index = queue.indexOf(job.id);
			if (index >= 0) queue.splice(index, 1);
			void finalizeJob(job, {
				status: "stopped",
				exitCode: 0,
				terminationReason: "explicit_stop",
				error: "Stopped by /agents stop before execution.",
			});
			return true;
		}
		const processRef = job.process;
		if (!processRef) {
			void finalizeJob(job, {
				status: "stopped",
				exitCode: 0,
				terminationReason: "explicit_stop",
				error: "Stopped by /agents stop.",
			});
			return true;
		}
		// The public snapshot must show `stopping` while the stop request is active.
		flushWebAgents();
		job.stopEscalation = terminateWithGrace({
			process: processRef,
			graceMs: job.config.execution.terminateGraceMs,
			onEscalate: () => {
				void finalizeJob(job, {
					status: "stopped",
					exitCode: 137,
					signal: "SIGKILL",
					terminationReason: "explicit_stop",
					error: `Stopped by /agents stop; worker required SIGKILL after ${job.config.execution.terminateGraceMs}ms.`,
				});
			},
		});
		return true;
	};

	// --- PI WEB activity registry (workspace registry only when PI_WEB_SESSION=1) ---

	const startWebTimers = () => {
		if (webHeartbeatTimer) {
			clearInterval(webHeartbeatTimer);
			webHeartbeatTimer = undefined;
		}
		if (webControlPollTimer) {
			clearInterval(webControlPollTimer);
			webControlPollTimer = undefined;
		}
		// 5s liveness heartbeat: runtime.json is written unconditionally while the
		// session runtime is alive, even with zero active jobs, so the browser
		// panel never misclassifies an idle-but-live session as dead. Agents
		// snapshots remain transition/progress based (flushed only when dirty).
		webHeartbeatTimer = setInterval(() => {
			if (!webRegistry) return;
			flushWebRuntime("active");
			if (webProgressDirty) flushWebAgents();
		}, 5000);
		webHeartbeatTimer.unref?.();
		// Poll for atomic control-request files published by the browser plugin.
		webControlPollTimer = setInterval(() => {
			void webDispatcher?.poll().catch(() => {});
		}, 1000);
		webControlPollTimer.unref?.();
	};

	const stopWebTimers = () => {
		if (webHeartbeatTimer) {
			clearInterval(webHeartbeatTimer);
			webHeartbeatTimer = undefined;
		}
		if (webControlPollTimer) {
			clearInterval(webControlPollTimer);
			webControlPollTimer = undefined;
		}
	};

	const startWebActivity = async (ctx: ExtensionContext) => {
		// A fresh generation + control token invalidates any stale request files
		// left over from a previous session runtime. The epoch guards against a
		// create that resolves after shutdown or after a newer session_start.
		const epoch = ++webStartEpoch;
		webGeneration += 1;
		webRuntimeId = `sa-${uuidv7()}`;
		webControlToken = randomBytes(32).toString("hex");
		webRuntimeStartedAt = Date.now();
		webDispatcher = undefined;
		const registry = await WebActivityRegistry.create({
			cwd: ctx.cwd,
			identity: {
				sessionId: ctx.sessionManager.getSessionId(),
				runtimeId: webRuntimeId,
				generation: webGeneration,
				controlToken: webControlToken,
			},
			env: process.env,
			notify: (message, kind) => {
				try {
					ctx.ui.notify(message, kind);
				} catch {
					// The browser panel also reads the registry directly.
				}
			},
		});
		// A late create (shutdown raced us, or a newer startup superseded us)
		// performs no registry assignment, dispatcher, timers, prune, writes, or
		// polls.
		if (!isWebActivityStartCurrent({ shuttingDown, epoch, currentEpoch: webStartEpoch })) {
			return;
		}
		webRegistry = registry.enabled ? registry : undefined;
		if (!webRegistry) return;
		// Best-effort cleanup of stale control files from earlier generations.
		void webRegistry.pruneOwnControlFiles().catch(() => {});
		webDispatcher = new ControlDispatcher(
			registry,
			{
				sessionId: ctx.sessionManager.getSessionId(),
				runtimeId: webRuntimeId,
				generation: webGeneration,
				controlToken: webControlToken,
			},
			{
				stopOne: (jobId: string) => {
					// Control stop_one matches the exact job id only. Names are
					// user-derived and may collide, so a name match could stop the
					// wrong job.
					const job = jobs.get(jobId);
					if (!job) return `unknown job: ${jobId}`;
					if (FINAL_STATUSES.has(job.status)) return `job ${job.name} is already ${job.status}`;
					if (job.stopRequest) return `job ${job.name} is already stopping`;
					const stopped = stopJob(job);
					return stopped ? `stop initiated for ${job.name}` : `job ${job.name} could not be stopped`;
				},
				stopAll: () => {
					const targets = [...jobs.values()].filter((job) => !FINAL_STATUSES.has(job.status));
					let stopped = 0;
					for (const job of targets) {
						if (stopJob(job)) stopped += 1;
					}
					updateUi();
					return `stop initiated for ${stopped} of ${targets.length} job(s)`;
				},
			},
		);
		startWebTimers();
		flushWebRuntime("active");
		flushWebAgents();
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
			const output = details.event === "failed" ? job.error || job.output || "(no output)" : job.output || job.error || "(no output)";
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
		// pi's public Shortcut type omits `override`, but the runtime accepts it.
		// @ts-ignore -- pre-existing type gap, kept for parity with the pi docs.
		override: true,
		handler: async (ctx) => openAgentBrowser(ctx),
	});

	pi.registerTool({
		name: "list_subagent_models",
		label: "List Sub-Agent Models",
		description: "List models currently eligible for delegate_subagent across all providers: strength tier, supported thinking levels, context window, and registry pricing. Call before dispatching a quality- or cost-sensitive sub-agent.",
		promptSnippet: "Inspect eligible sub-agent models, capability tiers, supported thinking levels, context windows, and registry pricing",
		promptGuidelines: [
			"Before the first quality- or cost-sensitive delegate_subagent call in a session, or when a previous catalogue may be stale, call list_subagent_models; reuse a recent result for similar dispatches instead of querying before every call.",
		],
		parameters: ListSubagentModelsParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			latestCtx = ctx;
			const config = loadConfig();
			const models = getEligibleModels(ctx);
			const currentRef = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			const descriptors = models.map((model) =>
				describeEligibleModel(ctx, model, config.modelProfiles, currentRef),
			);
			const options: ModelListOptions = {
				filter: params.filter,
				tier: params.tier,
				maxRows: Math.max(1, Math.min(50, Math.floor(params.maxRows ?? 20))),
				offset: Math.max(0, Math.floor(params.offset ?? 0)),
			};
			const { descriptors: page, result } = paginateModels(descriptors, options);
			const scope = ctx.scopedModels.length > 0 ? "session" : "all-authenticated";
			const details: ModelListDetails = {
				scope,
				totalEligible: models.length,
				matched: result.matched,
				shown: result.shown,
				offset: result.offset,
				nextOffset: result.nextOffset,
				truncated: result.truncated,
				models: page,
			};
			return {
				content: [{ type: "text", text: buildModelListText(page, result, scope) }],
				details,
			};
		},

		renderCall(args, theme) {
			const filters = [
				args.filter ? `filter=${args.filter}` : "",
				args.tier ? `tier=${args.tier}` : "",
			].filter(Boolean);
			return new Text(
				`${theme.fg("toolTitle", theme.bold("list_subagent_models"))}${filters.length > 0 ? theme.fg("dim", ` · ${filters.join(" · ")}`) : ""}`,
				0,
				0,
			);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ModelListDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "…"), 0, 0);
			const tiers: Record<EligibleModelDescriptor["tier"], number> = { S: 0, A: 0, B: 0, C: 0 };
			for (const model of details.models) tiers[model.tier] = tiers[model.tier] + 1;
			return new Text(
				`${theme.fg("accent", `${details.shown} eligible`)}${theme.fg("dim", ` · S${tiers.S} A${tiers.A} B${tiers.B} C${tiers.C} · scope ${details.scope}${details.truncated ? " · truncated" : ""}`)}`,
				0,
				0,
			);
		},
	});

	pi.registerTool({
		name: "delegate_subagent",
		label: "Delegate Sub Agent",
		description: "Dispatch a bounded task to an asynchronous sub-agent. Model, thinking effort, context inheritance and permission default to auto. The call returns after dispatch; completion is delivered automatically as a lifecycle message, so never poll or repeatedly check status.",
		promptSnippet: "Dispatch bounded asynchronous work with explicit or automatic model, thinking, context, and permission routing",
		promptGuidelines: [
			"Use delegate_subagent for concrete independent work that can run concurrently with useful local work; keep immediate critical-path blockers local.",
			"When list_subagent_models shows a clear fit, normally pass model and effort explicitly to delegate_subagent; also set contextMode and permission explicitly when the task semantics are clear.",
			"Any delegate_subagent routing field may remain auto. Use auto when no choice is well justified or model lookup is unavailable; the background advisor and deterministic rules provide a fail-open route when an eligible model exists.",
			"Treat list_subagent_models tiers as capability guidance and registry prices as cost metadata, not quality benchmarks. Do not default to the highest tier; choose the least costly model and effort that safely meet the task.",
			"Choose delegate_subagent contextMode independently: isolated for self-contained work, selected for the most recent parent messages, summary when semantic parent history matters, and full only when exact broad conversation details are indispensable.",
			"For delegate_subagent, use read-only for review or investigation and workspace-write only when mutation is required; provide a narrow writeScope for workspace-write tasks.",
			"Make every delegate_subagent task self-contained and provide precise contextFiles, contextNotes, and expectedOutput.",
			"Do not poll after delegate_subagent. Completion or failure is delivered automatically; continue meaningful non-overlapping work or yield.",
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
			const runDir = path.join(RUNS_DIR, ctx.sessionManager.getSessionId(), id);
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
				contextPath: path.join(runDir, "context.md"),
				logPath: path.join(runDir, "result.json"),
				lastProgressHookAt: 0,
				fallbackRoutes: [],
				parentMessages: [],
				parentConversation: "",
				contextNotes: params.contextNotes ?? "",
				toolActivitySeen: false,
				workerExtensions: [],
			};
			jobs.set(id, job);
			flushWebAgents();
			const ensureDispatchActive = () => {
				if (!shuttingDown && !FINAL_STATUSES.has(job.status)) return;
				throw new Error(job.stopRequest === "user" ? "Dispatch stopped by /agents stop." : "Dispatch stopped by session shutdown.");
			};
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
				ensureDispatchActive();
				job.parentMessages = routed.messages;
				job.parentConversation = routed.conversation;
				if (signal?.aborted) throw new Error("Dispatch aborted before spawn.");
				const models = getEligibleModels(ctx);
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
				// Preflight without network: extension-dependent/routed providers must
				// be covered by the configured trusted worker extensions, otherwise
				// the child would die in the provider composer at startup.
				const preflightError = preflightWorkerProvider(
					effectiveRoute.provider,
					config.execution.workerExtensions,
				);
				if (preflightError) throw new Error(preflightError);
				// Resolve trusted bootstrap files now so any missing/unknown/outside
				// path fails the dispatch with an actionable routing_error before spawn.
				job.workerExtensions = resolveWorkerExtensions(
					config.execution.workerExtensions,
					getAgentDir(),
				);
				job.route = effectiveRoute;
				job.fallbackRoutes = routeCandidates.filter((candidate) => {
					return preflightWorkerProvider(candidate.provider, config.execution.workerExtensions) === null;
				});
				await fs.promises.mkdir(runDir, { recursive: true, mode: 0o700 });
				ensureDispatchActive();
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
				if (!FINAL_STATUSES.has(job.status)) {
					await finalizeJob(job, {
						status: "failed",
						exitCode: 1,
						terminationReason: "routing_error",
						error: error instanceof Error ? error.message : String(error),
					});
				}
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
				if (target === "all" || target === "*") {
					const targets = [...jobs.values()].filter((job) => !FINAL_STATUSES.has(job.status));
					if (targets.length === 0) {
						ctx.ui.notify("No active sub-agents to stop", "info");
						return;
					}
					let stopped = 0;
					for (const job of targets) {
						if (stopJob(job)) stopped += 1;
					}
					updateUi();
					ctx.ui.notify(`Stopping ${stopped} of ${targets.length} sub-agents`, "info");
					return;
				}
				const job = [...jobs.values()].find((candidate) => candidate.id === target || candidate.name === target);
				if (!job) {
					ctx.ui.notify(`Sub-agent not found: ${target || "(missing target)"}`, "error");
					return;
				}
				const stopping = stopJob(job);
				ctx.ui.notify(
					stopping ? `Stopping ${job.name}` : job.timedOutAt ? `${job.name} is already timing out` : job.stopRequest ? `${job.name} is already stopping` : `${job.name} is already ${job.status}`,
					"info",
				);
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
		// Registry, control watcher, and heartbeat timers only start here and
		// only stop in session_shutdown.
		void startWebActivity(ctx);
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

	pi.on("session_shutdown", async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		durationRefreshLoop.stop();
		stopWebTimers();
		if (uiExpiryTimer) {
			clearTimeout(uiExpiryTimer);
			uiExpiryTimer = undefined;
		}
		if (agentBrowserRenderTimer) {
			clearTimeout(agentBrowserRenderTimer);
			agentBrowserRenderTimer = undefined;
		}
		agentBrowserRequestRender = undefined;
		deferredCompletionMessages.splice(0);
		parentAgentActive = false;
		queue.splice(0, queue.length);
		if (latestCtx?.hasUI) {
			try {
				releaseActivityWidgetSection(latestCtx.ui, activityWidgetOwner);
				latestCtx.ui.setStatus("smart-subagents", undefined);
			} catch { /* UI already gone */ }
		}
		await shutdownJobs(jobs.values(), {
			markStopping(job) {
				job.stopRequest = "shutdown";
				job.executionTimeout?.cancel();
				job.executionTimeout = undefined;
				job.stopEscalation?.cancel();
				job.stopEscalation = undefined;
			},
			async finalize(job) {
				await finalizeJob(job, {
					status: "stopped",
					exitCode: job.status === "running" ? 143 : 0,
					terminationReason: "session_shutdown",
					error: "Stopped because the parent session shut down.",
				}, { persistenceOnly: true });
			},
			terminate(processRef, job) {
				const child = processRef as ChildProcess;
				const termination = terminateWithGrace({
					process: child,
					graceMs: job.config.execution.terminateGraceMs,
				});
				child.once("close", () => termination.cancel());
			},
		});
		await Promise.all([...jobs.values()].map((job) => job.resultWritePromise).filter((promise): promise is Promise<void> => Boolean(promise)));
		// Final durable web snapshot. Timers were already stopped above, so this is
		// the single (and last) shutdown write. Await the serialized registry writes
		// as far as the API allows so teardown does not race the final state.
		try {
			if (webRegistry) {
				const writes: Promise<boolean>[] = [];
				const runtimeWrite = flushWebRuntime("shutdown");
				if (runtimeWrite) writes.push(runtimeWrite);
				const agentsWrite = flushWebAgents();
				if (agentsWrite) writes.push(agentsWrite);
				await Promise.all(writes);
			}
		} catch {
			// Panel observability must never block session teardown.
		}
		webRegistry = undefined;
		webDispatcher = undefined;
		latestCtx = undefined;
	});
}
