import {
	sanitizeWorkerExtensionKeys,
	type WorkerExtensionKey,
} from "./worker-bootstrap.ts";

export type Complexity = "simple" | "medium" | "complex" | "critical";
export type ContextMode = "isolated" | "selected" | "summary" | "full";
export type PermissionMode = "read-only" | "workspace-write";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ModelTier = "S" | "A" | "B" | "C";
export type TierSource = "configured" | "default";

export interface RouteConfig {
	models: string[];
	effort: ThinkingLevel;
	context: ContextMode;
}

export interface ModelProfileConfig {
	tier: ModelTier;
	note: string;
}

export interface ModelProfilesConfig {
	defaultTier: ModelTier;
	models: Record<string, ModelProfileConfig>;
}

export interface SmartSubagentConfig {
	maxConcurrent: number;
	maxRecentJobs: number;
	router: {
		enabled: boolean;
		model: string;
		effort: ThinkingLevel;
		maxConversationChars: number;
		maxSummaryChars: number;
	};
	context: {
		maxFullChars: number;
		maxSelectedChars: number;
		selectedMessages: number;
	};
	execution: {
		hardTimeoutMs: number;
		terminateGraceMs: number;
		workerExtensions: WorkerExtensionKey[];
	};
	modelProfiles: ModelProfilesConfig;
	routes: Record<Complexity, RouteConfig>;
	hooks: Partial<Record<"started" | "progress" | "completed" | "failed" | "stopped", string[]>>;
}

export interface ClassifierDecision {
	complexity: Complexity;
	contextMode: ContextMode;
	permission: PermissionMode;
	reason: string;
	contextSummary: string;
}

export const DEFAULT_CONFIG: SmartSubagentConfig = {
	maxConcurrent: 4,
	maxRecentJobs: 8,
	router: {
		enabled: true,
		model: "openai-codex/gpt-5.4-mini",
		effort: "low",
		maxConversationChars: 24000,
		maxSummaryChars: 6000,
	},
	context: {
		maxFullChars: 40000,
		maxSelectedChars: 12000,
		selectedMessages: 6,
	},
	// A 30-minute wall-clock cap contains orphaned/stuck workers while leaving
	// substantial headroom for max-thinking tasks. Shutdown escalates after 5s.
	execution: {
		hardTimeoutMs: 30 * 60 * 1000,
		terminateGraceMs: 5000,
		// Trusted worker bootstrap, loaded in this fixed order after
		// --no-extensions: codex-multi-account, provider-routing, then
		// codex-web-search (gives workers the web_search tool).
		workerExtensions: ["codex-multi-account", "provider-routing", "codex-web-search"],
	},
	modelProfiles: {
		defaultTier: "B",
		models: {
			"openai-codex/gpt-5.6-sol": {
				tier: "S",
				note: "最强推理，高风险/复杂任务",
			},
			"openai-codex/gpt-5.6-luna": {
				tier: "A",
				note: "快且便宜；开 max 思考后明显优于 5.5/5.4",
			},
			"openai-codex/gpt-5.5": {
				tier: "B",
				note: "通用编码与评审",
			},
			"openai-codex/gpt-5.4": {
				tier: "B",
				note: "通用编码与评审",
			},
			"openai-codex/gpt-5.4-mini": {
				tier: "C",
				note: "轻量快速，简单任务省钱",
			},
			"opencode-go/deepseek-v4-flash": {
				tier: "C",
				note: "日常主力，便宜快速",
			},
		},
	},
	routes: {
		simple: {
			models: [
				"openai-codex/gpt-5.4-mini",
				"openai-codex/gpt-5.3-codex-spark",
				"$current",
			],
			effort: "low",
			context: "isolated",
		},
		medium: {
			models: [
				"openai-codex/gpt-5.4-mini",
				"openai-codex/gpt-5.4",
				"$current",
			],
			effort: "medium",
			context: "selected",
		},
		complex: {
			models: [
				"openai-codex/gpt-5.6-sol",
				"openai-codex/gpt-5.5",
				"$current",
			],
			effort: "max",
			context: "summary",
		},
		critical: {
			models: [
				"openai-codex/gpt-5.6-sol",
				"$current",
			],
			effort: "max",
			context: "summary",
		},
	},
	hooks: {},
};

const COMPLEXITIES: Complexity[] = ["simple", "medium", "complex", "critical"];
const CONTEXT_MODES: ContextMode[] = ["isolated", "selected", "summary", "full"];
const PERMISSION_MODES: PermissionMode[] = ["read-only", "workspace-write"];
const MODEL_TIERS: ModelTier[] = ["S", "A", "B", "C"];
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(raw: unknown): SmartSubagentConfig {
	if (!isRecord(raw)) return structuredClone(DEFAULT_CONFIG);
	const router = isRecord(raw.router) ? raw.router : {};
	const context = isRecord(raw.context) ? raw.context : {};
	const execution = isRecord(raw.execution) ? raw.execution : {};
	const routes = isRecord(raw.routes) ? raw.routes : {};
	const hooks = isRecord(raw.hooks) ? raw.hooks : {};
	const merged = structuredClone(DEFAULT_CONFIG);

	if (typeof raw.maxConcurrent === "number") merged.maxConcurrent = Math.max(1, Math.min(16, raw.maxConcurrent));
	if (typeof raw.maxRecentJobs === "number") merged.maxRecentJobs = Math.max(1, Math.min(50, raw.maxRecentJobs));
	if (typeof router.enabled === "boolean") merged.router.enabled = router.enabled;
	if (typeof router.model === "string") merged.router.model = router.model;
	if (typeof router.effort === "string" && THINKING_LEVELS.includes(router.effort as ThinkingLevel)) {
		merged.router.effort = router.effort as ThinkingLevel;
	}
	if (typeof router.maxConversationChars === "number") {
		merged.router.maxConversationChars = Math.max(2000, Math.min(100000, router.maxConversationChars));
	}
	if (typeof router.maxSummaryChars === "number") {
		merged.router.maxSummaryChars = Math.max(500, Math.min(20000, router.maxSummaryChars));
	}
	if (typeof context.maxFullChars === "number") {
		merged.context.maxFullChars = Math.max(4000, Math.min(120000, context.maxFullChars));
	}
	if (typeof context.maxSelectedChars === "number") {
		merged.context.maxSelectedChars = Math.max(2000, Math.min(40000, context.maxSelectedChars));
	}
	if (typeof context.selectedMessages === "number") {
		merged.context.selectedMessages = Math.max(1, Math.min(50, context.selectedMessages));
	}
	if (typeof execution.hardTimeoutMs === "number" && Number.isFinite(execution.hardTimeoutMs)) {
		merged.execution.hardTimeoutMs = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, Math.floor(execution.hardTimeoutMs)));
	}
	if (typeof execution.terminateGraceMs === "number" && Number.isFinite(execution.terminateGraceMs)) {
		merged.execution.terminateGraceMs = Math.max(100, Math.min(60_000, Math.floor(execution.terminateGraceMs)));
	}
	// Symbolic keys only; unknown/traversal-like entries are dropped and the
	// fixed order is enforced here so config can never reorder the bootstrap.
	if (Array.isArray(execution.workerExtensions)) {
		merged.execution.workerExtensions = sanitizeWorkerExtensionKeys(execution.workerExtensions);
	}

	const profiles = isRecord(raw.modelProfiles) ? raw.modelProfiles : {};
	if (typeof profiles.defaultTier === "string" && MODEL_TIERS.includes(profiles.defaultTier as ModelTier)) {
		merged.modelProfiles.defaultTier = profiles.defaultTier as ModelTier;
	}
	const profileModels = isRecord(profiles.models) ? profiles.models : {};
	for (const [ref, candidate] of Object.entries(profileModels)) {
		if (!isRecord(candidate)) continue;
		if (typeof candidate.tier !== "string" || !MODEL_TIERS.includes(candidate.tier as ModelTier)) continue;
		const note = typeof candidate.note === "string" ? candidate.note.trim().slice(0, 300) : "";
		merged.modelProfiles.models[ref] = { tier: candidate.tier as ModelTier, note };
	}

	for (const complexity of COMPLEXITIES) {
		const candidate = routes[complexity];
		if (!isRecord(candidate)) continue;
		if (Array.isArray(candidate.models)) {
			const models = candidate.models.filter((item): item is string => typeof item === "string" && item.length > 0);
			if (models.length > 0) merged.routes[complexity].models = models;
		}
		if (typeof candidate.effort === "string" && THINKING_LEVELS.includes(candidate.effort as ThinkingLevel)) {
			merged.routes[complexity].effort = candidate.effort as ThinkingLevel;
		}
		if (typeof candidate.context === "string" && CONTEXT_MODES.includes(candidate.context as ContextMode)) {
			merged.routes[complexity].context = candidate.context as ContextMode;
		}
	}

	for (const event of ["started", "progress", "completed", "failed", "stopped"] as const) {
		const commands = hooks[event];
		if (Array.isArray(commands)) {
			merged.hooks[event] = commands.filter((command): command is string => typeof command === "string" && command.trim().length > 0);
		}
	}
	return merged;
}

export function fallbackComplexity(task: string, expectedOutput = "", contextNotes = ""): Complexity {
	const text = `${task}\n${expectedOutput}\n${contextNotes}`.toLowerCase();
	const criticalSignals = [
		/\bsecurity\b|安全/,
		/\bvulnerabilit(?:y|ies)\b|漏洞/,
		/\bdata loss\b|数据丢失/,
		/\bproduction\b|生产/,
		/\bconcurrenc(?:y|t)\b|并发/,
		/\brace condition\b|竞态/,
		/\bdistributed\b|分布式/,
		/\bdeadlock\b|死锁/,
	];
	const criticalHits = criticalSignals.filter((pattern) => pattern.test(text)).length;
	if (criticalHits >= 3) return "critical";
	let score = 0;
	if (text.length > 500) score += 1;
	if (text.length > 1400) score += 1;
	if (/\b(architecture|migration|distributed|concurrency|race condition|security|vulnerability|incident|production|data loss|deadlock|protocol|compiler)\b|架构|迁移|分布式|并发|竞态|安全|漏洞|生产|数据丢失|死锁|协议/.test(text)) score += 2;
	if (/\b(cross[- ]module|end[- ]to[- ]end|system[- ]wide|root cause|threat model|formal|benchmark)\b|跨模块|端到端|系统级|根因|威胁建模|形式化|基准/.test(text)) score += 2;
	if (/\b(refactor|implement|redesign|integrate|optimi[sz]e|audit|review)\b|重构|实现|重新设计|集成|优化|审计|评审/.test(text)) score += 1;
	if (/\b(find|locate|list|rename|format|summari[sz]e|simple|small)\b|查找|定位|列出|改名|格式化|总结|简单|小改/.test(text)) score -= 1;
	if (score >= 5) return "critical";
	if (score >= 3) return "complex";
	if (score >= 1) return "medium";
	return "simple";
}

export function fallbackPermission(task: string): PermissionMode {
	const text = task.toLowerCase();
	const readIntent = /\b(review|audit|analy[sz]e|inspect|investigate|find|locate|explain)\b|审查|审计|分析|检查|调查|查找|定位|解释/.test(text);
	const strongWriteIntent = /\b(implement|change|modify|refactor|add|remove|update|create|write|patch|migrate|apply)\b|实现|修改|重构|新增|删除|更新|创建|编写|打补丁|迁移|应用/.test(text);
	const reviewThenFix = /\b(?:and|then)\s+fix\b|并修复|然后修复/.test(text);
	if (readIntent && !strongWriteIntent && !reviewThenFix) return "read-only";
	return /\b(implement|fix|change|modify|refactor|add|remove|update|create|write|patch|migrate|apply)\b|实现|修复|修改|重构|新增|删除|更新|创建|编写|打补丁|迁移|应用/.test(text)
		? "workspace-write"
		: "read-only";
}

export function parseClassifierDecision(text: string, fallback: ClassifierDecision): ClassifierDecision {
	const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
	const start = unfenced.indexOf("{");
	const end = unfenced.lastIndexOf("}");
	if (start < 0 || end <= start) return fallback;
	try {
		const value = JSON.parse(unfenced.slice(start, end + 1)) as Record<string, unknown>;
		return {
			complexity:
				typeof value.complexity === "string" && COMPLEXITIES.includes(value.complexity as Complexity)
					? (value.complexity as Complexity)
					: fallback.complexity,
			contextMode:
				typeof value.context_mode === "string" && CONTEXT_MODES.includes(value.context_mode as ContextMode)
					? (value.context_mode as ContextMode)
					: fallback.contextMode,
			permission:
				typeof value.permission === "string" && PERMISSION_MODES.includes(value.permission as PermissionMode)
					? (value.permission as PermissionMode)
					: fallback.permission,
			reason: typeof value.reason === "string" && value.reason.trim() ? value.reason.trim() : fallback.reason,
			contextSummary:
				typeof value.context_summary === "string" ? value.context_summary.trim() : fallback.contextSummary,
		};
	} catch {
		return fallback;
	}
}

export function selectModelCandidates(
	availableRefs: string[],
	currentRef: string | undefined,
	complexity: Complexity,
	config: SmartSubagentConfig,
	override?: string,
): string[] {
	const available = new Set(availableRefs);
	if (override && override !== "auto") {
		if (available.has(override)) return [override];
		const byId = availableRefs.filter((ref) => ref.split("/").slice(1).join("/") === override);
		return byId.length === 1 ? byId : [];
	}
	const candidates: string[] = [];
	for (const candidate of config.routes[complexity].models) {
		const resolved = candidate === "$current" ? currentRef : candidate;
		if (resolved && available.has(resolved) && !candidates.includes(resolved)) candidates.push(resolved);
	}
	if (currentRef && available.has(currentRef) && !candidates.includes(currentRef)) candidates.push(currentRef);
	if (candidates.length === 0 && availableRefs[0]) candidates.push(availableRefs[0]);
	return candidates;
}


export function clampThinkingLevel(requested: ThinkingLevel, supported: string[]): ThinkingLevel {
	const valid = supported.filter((level): level is ThinkingLevel => THINKING_LEVELS.includes(level as ThinkingLevel));
	if (valid.length === 0) return "off";
	if (valid.includes(requested)) return requested;
	const requestedIndex = THINKING_LEVELS.indexOf(requested);
	return valid.reduce((best, level) => {
		const bestDistance = Math.abs(THINKING_LEVELS.indexOf(best) - requestedIndex);
		const distance = Math.abs(THINKING_LEVELS.indexOf(level) - requestedIndex);
		return distance < bestDistance ? level : best;
	}, valid[0]);
}

export function scopesOverlap(a: string[], b: string[]): boolean {
	if (a.length === 0 || b.length === 0) return true;
	const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
	return a.some((leftRaw) => {
		const left = normalize(leftRaw);
		return b.some((rightRaw) => {
			const right = normalize(rightRaw);
			return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
		});
	});
}

// ---------------------------------------------------------------------------
// Model catalogue (list_subagent_models)
// ---------------------------------------------------------------------------

export interface ParentMessage {
	role: "user" | "assistant";
	text: string;
}

export interface EligibleModelDescriptor {
	ref: string;
	provider: string;
	providerName: string;
	id: string;
	name: string;
	current: boolean;
	tier: ModelTier;
	tierSource: TierSource;
	note: string;
	thinkingLevels: string[];
	contextWindow: number;
	maxTokens: number;
	costInput: number;
	costOutput: number;
	costTiered: boolean;
}

export interface ModelListOptions {
	filter?: string;
	tier?: ModelTier;
	maxRows: number;
	offset: number;
}

export interface ModelListResult {
	matched: number;
	shown: number;
	offset: number;
	nextOffset?: number;
	truncated: boolean;
}

/** Resolve the tier annotation for a model ref; unprofiled models get the neutral default. */
export function resolveModelProfile(
	profiles: ModelProfilesConfig,
	ref: string,
): { tier: ModelTier; tierSource: TierSource; note: string } {
	const entry = profiles.models[ref];
	if (entry && MODEL_TIERS.includes(entry.tier)) {
		return { tier: entry.tier, tierSource: "configured", note: entry.note ?? "" };
	}
	return { tier: profiles.defaultTier, tierSource: "default", note: "" };
}

/** Return the last `count` parent messages, preserving order. */
export function recentMessages(messages: ParentMessage[], count: number): ParentMessage[] {
	if (count <= 0) return [];
	return messages.slice(-count);
}

/** Compress a supported-thinking-level list to a compact label. */
export function formatThinkingLevels(levels: string[]): string {
	const known = THINKING_LEVELS;
	const present = levels.filter((level): level is ThinkingLevel => known.includes(level as ThinkingLevel));
	if (present.length === 0) return "?";
	if (present.length === known.length) return "all";
	const indices = present.map((level) => known.indexOf(level)).sort((a, b) => a - b);
	if (indices.length === 1) return known[indices[0]];
	const contiguous = indices.length === indices[indices.length - 1]! - indices[0]! + 1;
	if (contiguous) return `${known[indices[0]]}..${known[indices[indices.length - 1]]}`;
	return present.join(",");
}

export function formatContextWindow(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M tok`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k tok`;
	return `${tokens} tok`;
}

export function formatPrice(usd: number): string {
	if (!Number.isFinite(usd) || usd <= 0) return "-";
	if (usd < 0.01) return usd.toFixed(4);
	if (usd < 1) return usd.toFixed(3);
	return usd.toFixed(2);
}

/** Apply filter + tier narrowing and pagination over eligible model descriptors. */
export function paginateModels(
	descriptors: EligibleModelDescriptor[],
	options: ModelListOptions,
): { descriptors: EligibleModelDescriptor[]; result: ModelListResult } {
	const needle = options.filter?.trim().toLowerCase();
	const filtered = descriptors.filter((descriptor) => {
		if (options.tier && descriptor.tier !== options.tier) return false;
		if (!needle) return true;
		return (
			descriptor.ref.toLowerCase().includes(needle) ||
			descriptor.name.toLowerCase().includes(needle) ||
			descriptor.providerName.toLowerCase().includes(needle) ||
			descriptor.note.toLowerCase().includes(needle)
		);
	});
	const offset = Math.max(0, options.offset);
	const shown = filtered.slice(offset, offset + options.maxRows);
	const truncated = offset + shown.length < filtered.length;
	return {
		descriptors: shown,
		result: {
			matched: filtered.length,
			shown: shown.length,
			offset,
			nextOffset: truncated ? offset + shown.length : undefined,
			truncated,
		},
	};
}

/** Build the LLM-facing model catalogue text. */
export function buildModelListText(
	descriptors: EligibleModelDescriptor[],
	result: ModelListResult,
	scope: string,
): string {
	const header = [
		`Eligible sub-agent models: ${result.matched}${result.truncated ? ` · showing ${result.shown}` : ""} · scope: ${scope}`,
		"TIER: curated capability guidance, not a benchmark; * = unprofiled model with neutral default tier.",
		"Price: registry USD per 1M tokens (in/out); '-' = free, local, or missing metadata. Context: model window.",
		"",
	];
	if (descriptors.length === 0) {
		return `${header.join("\n")}No models match. Widen the filter, drop the tier, or check that providers are authenticated.`;
	}
	const refWidth = Math.min(44, Math.max(...descriptors.map((descriptor) => descriptor.ref.length)) + 2);
	const lines = descriptors.map((descriptor) => {
		const tier = descriptor.tierSource === "default" ? `${descriptor.tier}*` : descriptor.tier;
		const thinking = formatThinkingLevels(descriptor.thinkingLevels);
		const context = formatContextWindow(descriptor.contextWindow);
		const price = `${formatPrice(descriptor.costInput)}/${formatPrice(descriptor.costOutput)}${descriptor.costTiered ? " t" : ""}`;
		const note = descriptor.note || (descriptor.tierSource === "default" ? "unprofiled" : "");
		const noteText = note.length > 60 ? `${note.slice(0, 60)}…` : note;
		const marker = descriptor.current ? " ◀ current" : "";
		return [
			descriptor.ref.padEnd(refWidth),
			tier.padEnd(6),
			thinking.padEnd(12),
			context.padEnd(9),
			price.padEnd(12),
			`${noteText}${marker}`,
		].join("| ").replace(/\s+$/g, "");
	});
	if (result.truncated) {
		lines.push(`Showing ${result.shown} of ${result.matched} matched models. Call again with offset=${result.nextOffset} or a narrower filter/tier.`);
	}
	return `${header.join("\n")}${lines.join("\n")}`;
}
