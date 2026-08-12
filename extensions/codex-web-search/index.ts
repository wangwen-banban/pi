import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatSearchResponse, runWebSearch, type SearchResponse } from "./search.ts";

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description:
		"Search the live web. Uses OpenAI Codex Web Search first and automatically falls back to a free search provider only when Codex auth/search is unavailable. Returns grounded text and source URLs. Use for current facts, documentation, releases, news, or other information that may have changed. This tool only searches; it does not fetch or browse arbitrary pages.",
	promptSnippet: "Search the live web with Codex-first, free-fallback routing",
	promptGuidelines: [
		"Use web_search for current or time-sensitive information and cite the returned source URLs.",
		"Do not claim a source says something unless the web_search output supports it.",
	],
	parameters: Type.Object({
		query: Type.String({ minLength: 1, description: "Focused web search query" }),
		numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum sources to return (default 5)" })),
		recencyFilter: Type.Optional(Type.Union([
			Type.Literal("day"),
			Type.Literal("week"),
			Type.Literal("month"),
			Type.Literal("year"),
		], { description: "Prefer recent results from this time range" })),
		domainFilter: Type.Optional(Type.Array(Type.String(), {
			maxItems: 20,
			description: "Allowed domains; prefix a domain with - to exclude it",
		})),
	}, { additionalProperties: false }),
	executionMode: "parallel",

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		onUpdate?.({
			content: [{ type: "text", text: `Searching with Codex first: ${params.query}` }],
			details: { provider: "codex", fallbackUsed: false, status: "searching" },
		});
		const response = await runWebSearch(params, ctx, signal);
		return {
			content: [{ type: "text", text: formatSearchResponse(response) }],
			details: {
				provider: response.provider,
				fallbackUsed: response.fallbackUsed,
				sourceCount: response.results.length,
				...(response.codexError ? { codexError: response.codexError } : {}),
			},
		};
	},
});

export default function codexWebSearch(pi: ExtensionAPI) {
	pi.registerTool(webSearchTool);
}

export type { SearchResponse };
