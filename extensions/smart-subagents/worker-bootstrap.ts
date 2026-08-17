import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Trusted worker provider bootstrap.
 *
 * Workers run with `--no-extensions`, so the dynamic providers the parent uses
 * (secondary Codex OAuth account, proxy-routed Codex and Claude relays) must be
 * loaded explicitly. Only audited provider extensions are allowed, resolved
 * from the agent directory, in a fixed order:
 *
 *   1. codex-multi-account — OAuth + models for `openai-codex-second`
 *   2. provider-routing    — proxy transport for `openai-codex`,
 *                            `openai-codex-second`, and the Claude relays
 *
 * `provider-routing` alone leaves `openai-codex-second` without oauth/models,
 * which aborts worker startup in the provider composer. The order is enforced
 * here, not by callers.
 */

export interface WorkerExtensionDescriptor {
	key: string;
	/** Path relative to `<agentDir>/extensions`. Symbolic keys only — never raw paths. */
	rel: string;
	/** Fixed load order. */
	order: number;
	/** Providers this extension supplies or routes for the worker. */
	providers: readonly string[];
}

export const WORKER_EXTENSIONS = {
	"codex-multi-account": {
		key: "codex-multi-account",
		rel: "codex-multi-account/index.ts",
		order: 0,
		providers: ["openai-codex-second"],
	},
	"provider-routing": {
		key: "provider-routing",
		rel: "provider-routing/index.ts",
		order: 1,
		providers: ["openai-codex", "openai-codex-second", "claude-relay", "claude-relay-alibaba", "big-data-claude"],
	},
} as const satisfies Record<string, WorkerExtensionDescriptor>;

export type WorkerExtensionKey = keyof typeof WORKER_EXTENSIONS;

export const WORKER_EXTENSION_KEYS = Object.keys(WORKER_EXTENSIONS) as WorkerExtensionKey[];

/**
 * Providers whose worker availability depends on one or more trusted worker
 * extensions. Any provider not listed here (builtins, unrelated providers)
 * continues to work in workers without a bootstrap check.
 */
export const WORKER_PROVIDER_DEPENDENCIES: Record<string, WorkerExtensionKey[]> = {
	// Builtin oauth/models; provider-routing supplies the transport route.
	"openai-codex": ["provider-routing"],
	// Needs codex-multi-account for oauth/models AND provider-routing for transport.
	"openai-codex-second": ["codex-multi-account", "provider-routing"],
	"claude-relay": ["provider-routing"],
	"claude-relay-alibaba": ["provider-routing"],
	"big-data-claude": ["provider-routing"],
};

export function isWorkerExtensionKey(value: string): value is WorkerExtensionKey {
	return Object.prototype.hasOwnProperty.call(WORKER_EXTENSIONS, value);
}

/**
 * Sanitize a raw config array: keep only known symbolic keys, dedupe, and sort
 * into the fixed load order. Unknown and traversal-like strings are dropped —
 * `execution.workerExtensions` must never become a path input.
 */
export function sanitizeWorkerExtensionKeys(raw: readonly unknown[]): WorkerExtensionKey[] {
	const seen = new Set<WorkerExtensionKey>();
	const keys: WorkerExtensionKey[] = [];
	for (const item of raw) {
		if (typeof item !== "string") continue;
		if (!isWorkerExtensionKey(item)) continue;
		if (seen.has(item)) continue;
		seen.add(item);
		keys.push(item);
	}
	keys.sort((a, b) => WORKER_EXTENSIONS[a].order - WORKER_EXTENSIONS[b].order);
	return keys;
}

export interface ResolvedWorkerExtension {
	key: WorkerExtensionKey;
	/** realpath'd absolute file, verified inside `<agentDir>/extensions`. */
	file: string;
}

export interface ResolveWorkerExtensionsRuntime {
	realpath?: (target: string) => string;
	stat?: (target: string) => fs.Stats;
}

/**
 * Resolve the configured symbolic extension keys to absolute, verified files.
 *
 * - unknown keys fail (never interpret a key as a path),
 * - the extensions root and each exact file are realpath'd,
 * - each file must exist, be a regular file, and stay inside the root,
 * - results are returned in the fixed table order.
 *
 * Throws actionable errors so dispatch fails before spawn.
 */
export function resolveWorkerExtensions(
	keys: readonly string[],
	agentDir: string,
	runtime: ResolveWorkerExtensionsRuntime = {},
): ResolvedWorkerExtension[] {
	const realpath = runtime.realpath ?? ((target: string) => fs.realpathSync(target));
	const stat = runtime.stat ?? ((target: string) => fs.statSync(target));
	const extensionsRoot = path.join(agentDir, "extensions");
	let realRoot: string;
	try {
		realRoot = realpath(extensionsRoot);
	} catch (error) {
		throw new Error(
			`Worker extensions directory is missing: ${extensionsRoot} (${describeError(error)}). ` +
			`Create it or fix execution.workerExtensions in ${path.join(agentDir, "subagents.json")}.`,
		);
	}
	const resolved: ResolvedWorkerExtension[] = [];
	const seenFiles = new Set<string>();
	for (const rawKey of keys) {
		const descriptor = (WORKER_EXTENSIONS as Record<string, WorkerExtensionDescriptor | undefined>)[rawKey];
		if (!descriptor) {
			throw new Error(
				`Unknown worker extension key "${rawKey}". Allowed keys: ${WORKER_EXTENSION_KEYS.join(", ")} ` +
				`(execution.workerExtensions in subagents.json accepts symbolic keys only).`,
			);
		}
		const candidate = path.join(extensionsRoot, descriptor.rel);
		let realFile: string;
		try {
			realFile = realpath(candidate);
		} catch (error) {
			throw new Error(
				`Worker extension "${rawKey}" could not be resolved: ${candidate} (${describeError(error)}). ` +
				`Fix execution.workerExtensions in subagents.json or restore the extension file.`,
			);
		}
		const relative = path.relative(realRoot, realFile);
		if (relative.startsWith("..") || path.isAbsolute(relative)) {
			throw new Error(
				`Worker extension "${rawKey}" resolves outside the extensions directory: ${realFile} ` +
				`(root ${realRoot}). Refusing to load it.`,
			);
		}
		let stats: fs.Stats;
		try {
			stats = stat(realFile);
		} catch (error) {
			throw new Error(
				`Worker extension "${rawKey}" could not be stat'd: ${realFile} (${describeError(error)}).`,
			);
		}
		if (!stats.isFile()) {
			throw new Error(`Worker extension "${rawKey}" is not a regular file: ${realFile}.`);
		}
		if (seenFiles.has(realFile)) continue;
		seenFiles.add(realFile);
		resolved.push({ key: rawKey as WorkerExtensionKey, file: realFile });
	}
	resolved.sort((a, b) => WORKER_EXTENSIONS[a.key].order - WORKER_EXTENSIONS[b.key].order);
	return resolved;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

/**
 * Build the worker CLI argument vector.
 *
 * `--no-extensions` stays, followed by the trusted `-e <file>` pairs in fixed
 * order, then `--model`/`--thinking`/`--tools`/`--append-system-prompt`, and
 * the prompt as the last positional argument. smart-subagents itself is never
 * included.
 */
export interface WorkerArgsInput {
	modelRef: string;
	effort: string;
	tools: string;
	contextPath: string;
	prompt: string;
	extensions: readonly ResolvedWorkerExtension[];
}

export function buildWorkerArgs(input: WorkerArgsInput): string[] {
	const args: string[] = [
		"--mode", "json",
		"-p",
		"--no-session",
		"--no-extensions",
	];
	for (const extension of input.extensions) {
		args.push("-e", extension.file);
	}
	args.push(
		"--model", input.modelRef,
		"--thinking", input.effort,
		"--tools", input.tools,
		"--append-system-prompt", input.contextPath,
		input.prompt,
	);
	return args;
}

/**
 * Preflight a routed provider against the configured worker extension keys,
 * without any network access. Returns null when the worker can serve the
 * provider, otherwise an actionable error for a `routing_error` failure.
 */
export function preflightWorkerProvider(
	provider: string,
	keys: readonly WorkerExtensionKey[],
): string | null {
	const required = WORKER_PROVIDER_DEPENDENCIES[provider];
	if (!required) return null;
	const missing = required.filter((key) => !keys.includes(key));
	if (missing.length === 0) return null;
	return (
		`Worker provider "${provider}" requires trusted worker extensions that are not configured: ${missing.join(", ")}. ` +
		`Add the missing keys to execution.workerExtensions in subagents.json ` +
		`(current: ${keys.length > 0 ? keys.join(", ") : "none"}). Dispatch was cancelled before spawn.`
	);
}

/**
 * The existing unsupported-model fallback must remain the only automatic
 * retry. A generic `fetch failed` (or similar transport failure) must never
 * silently fall back, and nothing may retry after possible side effects.
 */
const UNSUPPORTED_MODEL_PATTERN = /model[_ ]not[_ ]supported|unsupported model|requested model is not supported/i;

export function isUnsupportedModelFailure(failureText: string): boolean {
	return UNSUPPORTED_MODEL_PATTERN.test(failureText);
}

export interface FallbackDecisionInput {
	terminationReason: string;
	failureText: string;
	toolActivitySeen: boolean;
	changedFileCount: number;
	fallbackRouteCount: number;
}

export function mayFallbackAfterFailure(input: FallbackDecisionInput): boolean {
	return (
		(input.terminationReason === "exit_nonzero" || input.terminationReason === "child_error") &&
		!input.toolActivitySeen &&
		input.changedFileCount === 0 &&
		input.fallbackRouteCount > 0 &&
		isUnsupportedModelFailure(input.failureText)
	);
}

const FETCH_FAILURE_PATTERN = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_PROXY|socket hang up|network is unreachable|undici/i;

/**
 * Bounded diagnostic for a worker that died before any tool activity with a
 * generic transport/fetch failure. Never includes proxy URLs, auth values, or
 * other environment secrets.
 */
export function fetchFailureHint(failureText: string): string | null {
	if (!FETCH_FAILURE_PATTERN.test(failureText)) return null;
	return [
		"The worker exited before any tool activity with a transport/fetch failure.",
		"Possible cause: missing or misordered worker provider bootstrap — check execution.workerExtensions in subagents.json (expected order: codex-multi-account, then provider-routing) and the provider route entries — or an unreachable network route.",
		"No automatic fallback or retry was attempted for this failure. Inspect the run log and retry the dispatch once the worker transport is fixed.",
	].join("\n");
}
