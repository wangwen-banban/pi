import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ForkTurns = "all" | "none" | number;
type Entry = Record<string, any>;
export interface RequestEvidence {
	provider: string; model: string; baseUrl: string; signature: string;
	inputHashes: string[]; key?: string;
}
export interface ForkSnapshot {
	entries: Entry[]; systemPrompt: string; parentSessionId: string;
	provider: string; model: string; baseUrl: string; effort: string; cwd: string;
	evidence?: RequestEvidence;
}
export interface ForkSelection {
	entries: Entry[]; requested: ForkTurns | "auto"; effective: ForkTurns;
	estimatedTokens: number; reason: string; prefixIntact: boolean;
}

export function parseForkTurns(value: unknown, allowAuto = true): ForkTurns | "auto" {
	if (value === undefined || value === "auto") {
		if (allowAuto) return "auto";
		throw new Error("fork_turns must be all, none, or a positive integer");
	}
	if (value === "all" || value === "none") return value;
	if ((typeof value !== "number" && typeof value !== "string") || !/^[1-9]\d*$/.test(String(value))) {
		throw new Error("fork_turns must be all, none, auto, or a positive integer");
	}
	const n = Number(value);
	if (!Number.isSafeInteger(n) || n > 10000) throw new Error("fork_turns is out of range");
	return n;
}

/** Old tool calls remain readable; none of the aliases invokes a summarizer. */
export function requestedFork(params: { fork_turns?: unknown; contextMode?: string }, recentTurns = 3): ForkTurns | "auto" {
	const legacy = params.contextMode;
	const mapped = legacy === "isolated" ? "none" : legacy === "selected" ? recentTurns
		: legacy === "summary" || legacy === "full" ? "all" : "auto";
	if (params.fork_turns === undefined) return mapped;
	const explicit = parseForkTurns(params.fork_turns);
	if (mapped !== "auto" && explicit !== mapped) throw new Error("Conflicting fork_turns and deprecated contextMode; provide only fork_turns");
	return explicit;
}

/** Frozen before any advisor await. Only active model context, never all branch entries. */
export function captureFork(ctx: any, callId: string, evidence?: RequestEvidence): ForkSnapshot {
	const all = ctx.sessionManager.buildContextEntries();
	if (!Array.isArray(all)) throw new Error("Pi did not provide an effective context entry list");
	const cutoff = all.findIndex((entry: any) => entry.type === "message" && entry.message?.role === "assistant" &&
		Array.isArray(entry.message.content) && entry.message.content.some((part: any) => part.type === "toolCall" && part.id === callId));
	// The active delegation (and parallel siblings) has not completed. Never seed it as pending work.
	const entries = structuredClone(cutoff < 0 ? all : all.slice(0, cutoff)).filter((entry: any) =>
		["message", "compaction", "branch_summary", "custom_message"].includes(entry.type));
	const model = ctx.model;
	return {
		entries, systemPrompt: ctx.getSystemPrompt(), cwd: ctx.cwd, parentSessionId: ctx.sessionManager.getSessionId(),
		provider: model?.provider ?? "", model: model?.id ?? "", baseUrl: model?.baseUrl ?? "", effort: ctx.thinkingLevel ?? "unknown",
		evidence: evidence ? structuredClone(evidence) : undefined,
	};
}

function lastTurns(entries: Entry[], n: number): Entry[] {
	const starts = entries.flatMap((entry, i) => entry.type === "message" && entry.message?.role === "user" ? [i] : []);
	if (starts.length <= n) return entries;
	const begin = starts[starts.length - n];
	// A current compaction summary is evidence, not a new turn or an approval marker.
	const summary = entries.slice(0, begin).filter(entry => entry.type === "compaction").slice(-1);
	return [...summary, ...entries.slice(begin)];
}

/** Retain complete historical call/result pairs; do not synthesize success for pending tools. */
export function completeToolPairs(entries: Entry[]): { entries: Entry[]; changed: boolean } {
	const copies = structuredClone(entries);
	const calls = new Set<string>();
	const results = new Set<string>();
	for (const entry of copies) {
		const m = entry.message;
		if (m?.role === "assistant" && Array.isArray(m.content)) for (const p of m.content) if (p.type === "toolCall") calls.add(p.id);
		if (m?.role === "toolResult") results.add(m.toolCallId);
	}
	let changed = false;
	const output = copies.filter(entry => {
		const m = entry.message;
		if (m?.role === "toolResult" && !calls.has(m.toolCallId)) { changed = true; return false; }
		if (m?.role === "assistant" && Array.isArray(m.content)) {
			const content = m.content.filter((p: any) => p.type !== "toolCall" || results.has(p.id));
			if (content.length !== m.content.length) changed = true;
			m.content = content;
			if (!content.length) return false;
		}
		return true;
	});
	return { entries: output, changed };
}

/** Deliberately conservative heuristic, not a tokenizer or a billing measurement. */
export function estimateForkTokens(entries: Entry[]): number {
	let images = 0;
	const text = JSON.stringify(entries, (key, value) => {
		if (value && typeof value === "object" && value.type === "image") { images++; return { type: "image" }; }
		if (["usage", "details", "timestamp", "id", "parentId"].includes(key)) return undefined;
		return value;
	});
	return Math.ceil(Buffer.byteLength(text, "utf8") / 2) + images * 4096;
}

export function hasImages(entries: Entry[]): boolean {
	return entries.some(e => Array.isArray(e.message?.content) && e.message.content.some((p: any) => p.type === "image")) ||
		entries.some(e => e.type === "custom_message" && Array.isArray(e.content) && e.content.some((p: any) => p.type === "image"));
}

export function selectFork(snapshot: ForkSnapshot, requested: ForkTurns | "auto", suggested: ForkTurns,
	model: { provider: string; id: string; baseUrl?: string; contextWindow: number; input: string[] },
	options: { maxTokens: number; maxBytes: number; recentTurns: number; overheadTokens?: number }): ForkSelection {
	const budget = Math.min(options.maxTokens, Math.max(0, model.contextWindow - 16384 - (options.overheadTokens ?? 0)));
	const sameModel = model.provider === snapshot.provider && model.id === snapshot.model && model.baseUrl === snapshot.baseUrl;
	const choices: ForkTurns[] = requested === "auto" ? [...new Set<ForkTurns>([
		!sameModel && suggested === "all" ? options.recentTurns : suggested, options.recentTurns, 1, "none",
	])] : [requested];
	let modalityBlocked = false;
	for (const effective of choices) {
		if (effective === "none" && modalityBlocked) throw new Error("Selected model cannot consume the inherited images; choose an image-capable model rather than silently dropping evidence");
		const selected = effective === "none" ? [] : effective === "all" ? snapshot.entries : lastTurns(snapshot.entries, effective);
		if (!model.input.includes("image") && hasImages(selected)) {
			// Evidence cannot quietly disappear because the router selected a text-only model.
			if (requested !== "auto") throw new Error("Fork contains images unsupported by the selected model; choose an image-capable model or explicitly use fork_turns:none");
			modalityBlocked = true;
			continue;
		}
		const clean = completeToolPairs(selected);
		if (!sameModel) {
			for (const entry of clean.entries) {
				const m = entry.message;
				if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
				m.content = m.content.filter((p: any) => p.type !== "thinking").map((p: any) => {
					const result = { ...p }; delete result.textSignature; delete result.thoughtSignature; delete result.signature; return result;
				});
			}
		}
		const estimatedTokens = estimateForkTokens(clean.entries);
		if (effective !== "none" && (estimatedTokens > budget || Buffer.byteLength(JSON.stringify(clean.entries)) > options.maxBytes)) {
			if (requested !== "auto") throw new Error(`Explicit fork exceeds the configured/context budget (estimated ${estimatedTokens} tokens, budget ${budget}); choose fewer turns or a larger model`);
			continue;
		}
		return { entries: clean.entries, requested, effective, estimatedTokens: effective === "none" ? 0 : estimatedTokens,
			prefixIntact: sameModel && effective === "all" && !clean.changed,
			reason: requested === "auto" ? `Automatic fork=${effective}; model compatibility and context budget checked` : `Explicit fork=${effective}` };
	}
	throw new Error("No compatible fork selection");
}

/** Pi v3 native JSONL. New entry/session identities, original message roles and content. */
export function serializeFork(entries: Entry[], cwd: string, childId = randomUUID()): string {
	const timestamp = new Date().toISOString();
	const header = { type: "session", version: 3, id: childId, timestamp, cwd };
	let previous: string | null = null;
	const lines = [JSON.stringify(header)];
	for (const source of entries) {
		const id = randomUUID().replaceAll("-", "");
		const base = { type: source.type, id, parentId: previous, timestamp: source.timestamp ?? timestamp };
		let entry: Entry;
		switch (source.type) {
			case "message": entry = { ...base, message: source.message }; break;
			case "compaction": entry = { ...base, summary: source.summary, tokensBefore: source.tokensBefore ?? 0, firstKeptEntryId: id }; break;
			case "branch_summary": entry = { ...base, summary: source.summary, fromId: source.fromId }; break;
			case "custom_message": entry = { ...base, customType: source.customType, content: source.content, display: source.display ?? false }; break;
			default: continue; // Never inherit mutable extension/approval state or model settings.
		}
		lines.push(JSON.stringify(entry)); previous = id;
	}
	return `${lines.join("\n")}\n`;
}

export function privateFile(directory: string, name: string, content: string): string {
	if (path.basename(name) !== name) throw new Error("Invalid private artifact name");
	const file = path.join(directory, name);
	const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
	try { fs.writeFileSync(fd, content, "utf8"); } finally { fs.closeSync(fd); }
	return file;
}

function canonical(value: any): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value && typeof value === "object") return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");

/** Compare the complete non-conversation request semantics, never auth headers. */
export function requestEvidence(payload: unknown, model: any): RequestEvidence | undefined {
	if (!payload || typeof payload !== "object" || !["openai-codex-responses", "openai-responses"].includes(model?.api)) return;
	const p = payload as Entry;
	if (!Array.isArray(p.input) || p.input.length > 4096 || typeof p.model !== "string") return;
	const rest = { ...p };
	for (const key of ["input", "prompt_cache_key", "previous_response_id", "stream", "store", "metadata", "client_metadata"]) delete rest[key];
	return { provider: model.provider, model: p.model, baseUrl: model.baseUrl ?? "", signature: digest(rest),
		inputHashes: p.input.map((item: unknown) => digest(item)), key: typeof p.prompt_cache_key === "string" ? p.prompt_cache_key : undefined };
}

export function cacheDecision(current: RequestEvidence, parent: RequestEvidence | undefined, rootId: string,
	prefixIntact: boolean, enabled: boolean): { mode: "parent" | "siblings" | "independent"; key?: string; reason: string } {
	if (!enabled || !rootId || !current.key) return { mode: "independent", reason: "Shared cache grouping disabled" };
	if (prefixIntact && parent?.key && current.provider === parent.provider && current.model === parent.model &&
		current.baseUrl === parent.baseUrl && current.signature === parent.signature && parent.inputHashes.length > 0 &&
		parent.inputHashes.every((hash, i) => current.inputHashes[i] === hash)) {
		return { mode: "parent", key: parent.key, reason: "Full inherited request prefix and model/configuration match at the request hook" };
	}
	// Keep different tools, instructions, providers, models and effort in separate groups.
	// This only influences routing; it neither shares a connection nor promises a hit.
	return { mode: "siblings", key: `pi-sa-${digest([rootId, current.provider, current.baseUrl, current.model, current.signature]).slice(0, 48)}`,
		reason: "Independent parent prefix; group only compatible sibling requests" };
}
