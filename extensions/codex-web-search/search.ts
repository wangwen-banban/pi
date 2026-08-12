import { randomUUID } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const CODEX_SEARCH_URL = "https://chatgpt.com/backend-api/codex/alpha/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp?tools=web_search_exa";
const CODEX_TIMEOUT_MS = 60_000;
const FALLBACK_TIMEOUT_MS = 45_000;
const MAX_OUTPUT_CHARS = 16_000;

export type RecencyFilter = "day" | "week" | "month" | "year";

export interface WebSearchParams {
	query: string;
	numResults?: number;
	recencyFilter?: RecencyFilter;
	domainFilter?: string[];
}

export interface SearchResult {
	title: string;
	url: string;
	snippet?: string;
}

export interface SearchResponse {
	provider: "codex" | "exa";
	answer: string;
	results: SearchResult[];
	fallbackUsed: boolean;
	codexError?: string;
}

type ProviderHeaders = Record<string, string | null>;

interface CodexAuth {
	token: string;
	accountId: string;
	model: string;
	headers: ProviderHeaders;
}

function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeCount(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 5;
	return Math.max(1, Math.min(Math.floor(value), 20));
}

function normalizeDomain(value: string): string | undefined {
	let input = value.trim().toLowerCase();
	if (input.startsWith("-")) input = input.slice(1).trim();
	if (!input) return undefined;
	try {
		input = (input.includes("://") ? new URL(input) : new URL(`https://${input}`)).hostname;
	} catch {
		input = input.split("/")[0]?.split(":")[0] ?? "";
	}
	input = input.replace(/^\.+|\.+$/g, "");
	return /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i.test(input) ? input : undefined;
}

function normalizeDomainFilters(values: string[] | undefined): { allowed: string[]; blocked: string[] } {
	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of values ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blocked : allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return { allowed: allowed.slice(0, 100), blocked: blocked.slice(0, 100) };
}

function recencyDays(value: RecencyFilter | undefined): number | undefined {
	return value === "day" ? 1 : value === "week" ? 7 : value === "month" ? 30 : value === "year" ? 365 : undefined;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function accountIdFromToken(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!auth || typeof auth !== "object") return undefined;
	const accountId = (auth as Record<string, unknown>).chatgpt_account_id;
	return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function pickCodexModel(ctx: ExtensionContext) {
	const models = ctx.modelRegistry.getAll().filter((model) => model.provider === "openai-codex");
	if (models.length === 0) return undefined;
	const exact = models.find((model) => model.id === "gpt-5.6-terra");
	if (exact) return exact;
	return [...models]
		.filter((model) => !/(?:^|-)pro(?:-|$)|(?:^|-)ultra(?:-|$)/i.test(model.id))
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }))[0];
}

async function resolveCodexAuth(ctx: ExtensionContext): Promise<CodexAuth | undefined> {
	const model = pickCodexModel(ctx);
	if (!model) return undefined;
	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!resolved.ok || !resolved.apiKey) return undefined;
	const accountId = accountIdFromToken(resolved.apiKey);
	if (!accountId) return undefined;
	return {
		token: resolved.apiKey,
		accountId,
		model: model.id,
		headers: resolved.headers ?? {},
	};
}

function safeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]").slice(0, 500);
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
	if (signal?.aborted) return true;
	const message = safeError(error).toLowerCase();
	return message.includes("abort") && !message.includes("timeout");
}

function toHeaders(headers: ProviderHeaders): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) if (value !== null) result[key] = value;
	return result;
}

function mapCodexResults(value: unknown, count: number): SearchResult[] {
	if (!Array.isArray(value)) return [];
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (!item || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const url = typeof record.url === "string" ? record.url : undefined;
		if (!url || seen.has(url)) continue;
		seen.add(url);
		results.push({
			title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : url,
			url,
			...(typeof record.snippet === "string" && record.snippet.trim() ? { snippet: record.snippet.trim() } : {}),
		});
		if (results.length >= count) break;
	}
	return results;
}

export async function searchWithCodex(
	params: WebSearchParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	const auth = await resolveCodexAuth(ctx);
	if (!auth) throw new Error("Codex OAuth is not available");
	const count = normalizeCount(params.numResults);
	const domains = normalizeDomainFilters(params.domainFilter);
	const query: Record<string, unknown> = {
		q: params.query.trim(),
		...(recencyDays(params.recencyFilter) ? { recency: recencyDays(params.recencyFilter) } : {}),
		...(domains.allowed.length ? { domains: domains.allowed } : {}),
	};
	const body = {
		id: randomUUID(),
		model: auth.model,
		commands: {
			search_query: [query],
			response_length: count <= 5 ? "short" : count <= 10 ? "medium" : "long",
		},
		settings: {
			search_context_size: count <= 5 ? "low" : "medium",
			...(domains.allowed.length || domains.blocked.length ? {
				filters: {
					...(domains.allowed.length ? { allowed_domains: domains.allowed } : {}),
					...(domains.blocked.length ? { blocked_domains: domains.blocked } : {}),
				},
			} : {}),
			allowed_callers: ["direct"],
			external_web_access: true,
		},
		max_output_tokens: 6_000,
	};
	const response = await fetch(CODEX_SEARCH_URL, {
		method: "POST",
		headers: {
			...toHeaders(auth.headers),
			authorization: `Bearer ${auth.token}`,
			"chatgpt-account-id": auth.accountId,
			"content-type": "application/json",
			accept: "application/json",
			originator: "pi",
			"user-agent": "pi-codex-web-search/1.0",
		},
		body: JSON.stringify(body),
		signal: requestSignal(CODEX_TIMEOUT_MS, signal),
	});
	if (!response.ok) {
		const errorText = (await response.text()).replaceAll(auth.token, "[redacted]");
		throw new Error(`Codex search returned HTTP ${response.status}: ${errorText.slice(0, 300)}`);
	}
	const data = await response.json() as Record<string, unknown>;
	const answer = typeof data.output === "string" ? data.output.trim().slice(0, MAX_OUTPUT_CHARS) : "";
	const results = mapCodexResults(data.results, count);
	if (!answer && results.length === 0) throw new Error("Codex search returned no output or sources");
	return { provider: "codex", answer, results, fallbackUsed: false };
}

function parseExaEnvelope(text: string): string {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data:")) continue;
		try {
			const payload = JSON.parse(line.slice(5).trim()) as Record<string, unknown>;
			const error = payload.error as Record<string, unknown> | undefined;
			if (error) throw new Error(`Exa MCP error: ${String(error.message ?? "unknown error")}`);
			const result = payload.result as Record<string, unknown> | undefined;
			if (result?.isError) throw new Error("Exa MCP returned an error");
			const content = result?.content;
			if (!Array.isArray(content)) continue;
			const item = content.find((entry) => entry && typeof entry === "object" && (entry as Record<string, unknown>).type === "text");
			const value = item && typeof (item as Record<string, unknown>).text === "string"
				? (item as Record<string, unknown>).text as string
				: undefined;
			if (value?.trim()) return value.trim();
		} catch (error) {
			if (error instanceof SyntaxError) continue;
			throw error;
		}
	}
	throw new Error("Exa MCP returned no text results");
}

function parseExaResults(text: string, count: number): SearchResult[] {
	const results: SearchResult[] = [];
	const blocks = text.split(/(?=^Title:\s)/m);
	for (const block of blocks) {
		const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
		const url = block.match(/^URL:\s*(.+)$/m)?.[1]?.trim();
		if (!url) continue;
		const snippet = block.match(/(?:Highlights:|Text:)\s*\n?([\s\S]*?)(?:\n---\s*$|$)/m)?.[1]
			?.replace(/\s+/g, " ").trim().slice(0, 500);
		results.push({ title: title || url, url, ...(snippet ? { snippet } : {}) });
		if (results.length >= count) break;
	}
	return results;
}

function buildExaQuery(params: WebSearchParams): string {
	const parts = [params.query.trim()];
	for (const domain of params.domainFilter ?? []) {
		const normalized = normalizeDomain(domain);
		if (normalized) parts.push(domain.trim().startsWith("-") ? `-site:${normalized}` : `site:${normalized}`);
	}
	if (params.recencyFilter) parts.push(`past ${recencyDays(params.recencyFilter)} days`);
	return parts.join(" ");
}

export async function searchWithExa(params: WebSearchParams, signal?: AbortSignal): Promise<SearchResponse> {
	const count = normalizeCount(params.numResults);
	const response = await fetch(EXA_MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			"x-exa-source": "pi-codex-web-search-fallback",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: "web_search_exa",
				arguments: { query: buildExaQuery(params), numResults: count },
			},
		}),
		signal: requestSignal(FALLBACK_TIMEOUT_MS, signal),
	});
	if (!response.ok) throw new Error(`Exa MCP returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
	const answer = parseExaEnvelope(await response.text()).slice(0, MAX_OUTPUT_CHARS);
	const results = parseExaResults(answer, count);
	if (!answer && results.length === 0) throw new Error("Exa MCP returned no output or sources");
	return { provider: "exa", answer, results, fallbackUsed: true };
}

export async function runWebSearch(
	params: WebSearchParams,
	ctx: ExtensionContext,
	signal?: AbortSignal,
): Promise<SearchResponse> {
	if (!params.query?.trim()) throw new Error("query must be a non-empty string");
	try {
		return await searchWithCodex(params, ctx, signal);
	} catch (error) {
		if (isAbort(error, signal)) throw error;
		const codexError = safeError(error);
		try {
			return { ...(await searchWithExa(params, signal)), codexError };
		} catch (fallbackError) {
			if (isAbort(fallbackError, signal)) throw fallbackError;
			throw new Error(`Web search failed. Codex: ${codexError}. Free fallback: ${safeError(fallbackError)}`);
		}
	}
}

export function formatSearchResponse(response: SearchResponse): string {
	const provider = response.provider === "codex"
		? "OpenAI Codex Web Search (live)"
		: "Exa Web Search (free fallback)";
	const lines = [`Provider: ${provider}`, "", response.answer || "No synthesized text returned."];
	if (response.results.length > 0) {
		lines.push("", "---", "", "Sources:");
		for (const [index, result] of response.results.entries()) {
			lines.push(`${index + 1}. ${result.title}\n   ${result.url}`);
		}
	}
	if (response.fallbackUsed) {
		lines.push("", "Note: Codex search was unavailable, so the free fallback was used.");
	}
	return lines.join("\n");
}
