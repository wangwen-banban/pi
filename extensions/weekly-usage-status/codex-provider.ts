import path from "node:path";

export const CODEX_PROVIDER_IDS = ["openai-codex", "openai-codex-second"] as const;
export type CodexProviderId = (typeof CODEX_PROVIDER_IDS)[number];

const CODEX_CACHE_FILES: Record<CodexProviderId, string> = {
	"openai-codex": "codex-weekly-usage.json",
	"openai-codex-second": "codex-weekly-usage-second.json",
};

export function getCodexProviderId(provider: unknown): CodexProviderId | undefined {
	return CODEX_PROVIDER_IDS.includes(provider as CodexProviderId) ? (provider as CodexProviderId) : undefined;
}

export function getCodexCachePath(agentDir: string, provider: CodexProviderId): string {
	return path.join(agentDir, "cache", CODEX_CACHE_FILES[provider]);
}
