export type Complexity = "simple" | "medium" | "complex" | "critical";
export type ContextMode = "isolated" | "selected" | "summary" | "full";
export type PermissionMode = "read-only" | "workspace-write";
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RouteConfig {
	models: string[];
	effort: ThinkingLevel;
	context: ContextMode;
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
	};
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
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfig(raw: unknown): SmartSubagentConfig {
	if (!isRecord(raw)) return structuredClone(DEFAULT_CONFIG);
	const router = isRecord(raw.router) ? raw.router : {};
	const context = isRecord(raw.context) ? raw.context : {};
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
