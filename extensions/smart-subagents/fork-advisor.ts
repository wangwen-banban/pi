import { randomUUID } from "node:crypto";
import { fallbackComplexity, fallbackPermission, selectModelCandidates, clampThinkingLevel, type SmartSubagentConfig, type Complexity, type ThinkingLevel } from "./router.ts";
import { parseForkTurns, requestedFork, digest, type ForkTurns } from "./native-fork.ts";

export interface RoutingParams {
	task: string; expectedOutput?: string; contextNotes?: string; contextFiles?: string[];
	model?: string; effort?: string; complexity?: string; permission?: string;
	fork_turns?: unknown; contextMode?: string;
}
export interface RoutingModel {
	ref: string; name: string; tier: string; thinkingLevels: string[];
	contextWindow: number; input: string[]; costInput?: number; costOutput?: number;
}
export interface ParentMetadata {
	sessionId: string; model: string; effort: string; turns: number; estimatedTokens: number; hasImages: boolean;
}
export interface RoutingOutcome {
	complexity: Complexity; model: string; effort: ThinkingLevel; permission: "read-only" | "workspace-write";
	requestedFork: ForkTurns | "auto"; suggestedFork: ForkTurns; reason: string;
	usage?: any; advisor: { calls: number; model: string; fallbackReason?: string };
}
const explicit = (value: unknown) => typeof value === "string" && value !== "" && value !== "auto";

/** A selector, not a context summarizer: the API receives no raw parent history. */
export async function routeTask(params: RoutingParams, config: SmartSubagentConfig,
	models: RoutingModel[], parent: ParentMetadata,
	complete?: (ref: string, prompt: string, options: any) => Promise<any>, signal?: AbortSignal): Promise<RoutingOutcome> {
	const requested = requestedFork(params, config.context.forkRecentTurns);
	const complexity = explicit(params.complexity) ? params.complexity as Complexity
		: fallbackComplexity(params.task, params.expectedOutput, params.contextNotes);
	if (!["simple", "medium", "complex", "critical"].includes(complexity)) throw new Error("Invalid complexity");
	const available = models.map(m => m.ref);
	const chosen = selectModelCandidates(available, parent.model, complexity, config, params.model ?? "auto")[0];
	if (!chosen) throw new Error("No eligible model for sub-agent routing");
	const candidate = models.find(m => m.ref === chosen)!;
	const chooseEffort = (model: RoutingModel, wanted: string): ThinkingLevel =>
		clampThinkingLevel(wanted as ThinkingLevel, model.thinkingLevels);
	const defaultFork: ForkTurns = requested !== "auto" ? requested : complexity === "simple" ? "none"
		: (complexity === "complex" || complexity === "critical") && chosen === parent.model ? "all" : config.context.forkRecentTurns;
	const result: RoutingOutcome = {
		complexity, model: chosen, effort: chooseEffort(candidate, explicit(params.effort) ? params.effort! : config.routes[complexity].effort),
		permission: explicit(params.permission) ? params.permission as any : fallbackPermission(params.task),
		requestedFork: requested, suggestedFork: defaultFork,
		reason: "Deterministic routing", advisor: { calls: 0, model: config.router.model },
	};
	if (!["read-only", "workspace-write"].includes(result.permission)) throw new Error("Invalid permission");
	if (explicit(params.model) && explicit(params.effort) && requested !== "auto" && explicit(params.permission)) {
		result.reason = "Execution choices explicit; Spark advisor skipped"; return result;
	}
	if (!config.router.enabled || !complete) {
		result.advisor.fallbackReason = !config.router.enabled ? "Router disabled" : "Configured Spark/router model unavailable; no silent main-model fallback";
		result.reason += `: ${result.advisor.fallbackReason}`; return result;
	}
	// Include the current model and configured fallbacks before truncating the catalogue.
	const prioritized = [...new Set([parent.model, chosen, ...(["simple", "medium", "complex", "critical"] as const)
		.flatMap(c => selectModelCandidates(available, parent.model, c, config, "auto"))])];
	const candidates = prioritized.map(ref => models.find(m => m.ref === ref)).filter((m): m is RoutingModel => Boolean(m)).slice(0, 16);
	const taskInfo = { task: params.task, expectedOutput: params.expectedOutput, contextNotes: params.contextNotes, contextFiles: params.contextFiles };
	// Explicit task text is trusted only as task data; it cannot enlarge the catalogue or permission.
	const bounded = JSON.stringify(taskInfo).slice(0, config.router.maxTaskChars);
	const prompt = [
		"Select a model, thinking effort and history fork for a bounded delegated task. Return a short JSON object only.",
		'Fields: {"model":"exact catalogue ref","effort":"supported level","fork_turns":"all|none|positive integer","reason":"one short sentence"}. No summary, no tools, no permission decisions.',
		"Use none for self-contained work; recent turns for local context. Use all when broad parent context is needed, preferably on the same model and effort. Other models cannot reuse the parent's KV cache. Different effort/tools can also prevent reuse; never promise cache hits.",
		"Choose sufficient capability, not automatically the most expensive model. Respect explicit choices. If full context matters and capability suffices, prefer the parent model. Keep the complete reply under 120 words.",
		`CATALOGUE: ${JSON.stringify(candidates)}`,
		`PARENT METADATA ONLY: ${JSON.stringify(parent.sessionId ? { ...parent, sessionId: undefined } : parent)}`,
		`FIXED CHOICES: ${JSON.stringify({ model: params.model, effort: params.effort, fork_turns: requested })}`,
		`TASK DATA: ${bounded}`,
	].join("\n");
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(new Error("Router timeout")), config.router.timeoutMs);
	const timeout = controller.signal;
	const boundedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
	result.advisor.calls = 1;
	try {
		if (signal?.aborted) throw signal.reason;
		const response = await awaitWithSignal(complete(config.router.model, prompt, {
			reasoningEffort: config.router.effort, maxTokens: config.router.maxOutputTokens,
			cacheRetention: "short", sessionId: randomUUID(), signal: boundedSignal,
			onPayload(payload: any) {
				// Cache grouping only. Never change session/header/connection identity.
				if (payload && typeof payload === "object" && Array.isArray(payload.input)) {
					return { ...payload, prompt_cache_key: `pi-router-${digest([parent.sessionId, config.router.model]).slice(0, 48)}` };
				}
				return payload;
			},
		}), boundedSignal);
		result.usage = response.usage;
		if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error("Router request did not complete");
		const text = (response.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
		if (text.length > 8192) throw new Error("Router response exceeded validation limit");
		const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim());
		const picked = candidates.find(m => m.ref === parsed.model);
		if (!picked || !picked.thinkingLevels.includes(parsed.effort)) throw new Error("Router selected an unknown model/effort");
		const fork = parseForkTurns(parsed.fork_turns, false) as ForkTurns;
		if (!explicit(params.model)) result.model = picked.ref;
		const effectiveModel = models.find(m => m.ref === result.model)!;
		if (!explicit(params.effort)) result.effort = chooseEffort(effectiveModel, parsed.effort);
		if (requested === "auto") result.suggestedFork = fork;
		result.reason = typeof parsed.reason === "string" ? parsed.reason.slice(0, 240) : "Spark selected execution choices";
	} catch (error) {
		if (signal?.aborted) throw signal.reason ?? error;
		// A timed-out/unavailable selector never causes a second (more costly) LLM call.
		result.advisor.fallbackReason = timeout.aborted ? "Router timeout; deterministic fallback" : "Invalid or failed router response; deterministic fallback";
		result.reason += `: ${result.advisor.fallbackReason}`;
	} finally {
		clearTimeout(timer);
	}
	return result;
}

/** Bound the selector wait even if a custom provider ignores cancellation. */
async function awaitWithSignal<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason ?? new Error("Router aborted"));
		if (signal.aborted) { pending.catch(() => {}); abort(); return; }
		signal.addEventListener("abort", abort, { once: true });
		pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}
