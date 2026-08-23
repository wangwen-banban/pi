export const CODEX_FAST_MARKER_TYPE = "codex-fast-mode-v1";
export const CODEX_FAST_EVENT = "codex-fast-mode:changed";

export interface FastModeModel {
	provider: string;
	id: string;
}

export interface FastModeMarker {
	enabled: boolean;
	timestamp: number;
}

export interface FastModeBranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

export interface FastModeEvent {
	enabled: boolean;
	active: boolean;
	supported: boolean;
	provider: string;
	modelId: string;
	serviceTier: "priority" | "default";
}

export interface CodexServiceTierOptions {
	serviceTier?: string;
	[key: string]: unknown;
}

export function isCodexFastModel(model: FastModeModel | undefined): boolean {
	if (!model) return false;
	if (model.provider !== "openai-codex" && model.provider !== "openai-codex-second") return false;
	return model.id === "gpt-5.4" || model.id === "gpt-5.5" || /^gpt-5\.6(?:-|$)/.test(model.id);
}

export function buildFastModeMarker(enabled: boolean, timestamp = Date.now()): FastModeMarker {
	return { enabled, timestamp };
}

export function reconstructFastMode(entries: FastModeBranchEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (!entry || entry.type !== "custom" || entry.customType !== CODEX_FAST_MARKER_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const enabled = (data as { enabled?: unknown }).enabled;
		if (typeof enabled === "boolean") return enabled;
	}
	return false;
}

/** Add the raw Codex request tier through Pi's typed stream options. */
export function applyCodexFastServiceTier<T extends CodexServiceTierOptions | undefined>(
	options: T,
	model: FastModeModel,
	enabled: boolean,
): T | (CodexServiceTierOptions & { serviceTier: "priority" }) {
	if (!enabled || !isCodexFastModel(model)) return options;
	return { ...(options ?? {}), serviceTier: "priority" };
}

export function fastCreditMultiplier(modelId: string): number | undefined {
	if (modelId === "gpt-5.4") return 2;
	if (modelId === "gpt-5.5" || /^gpt-5\.6(?:-|$)/.test(modelId)) return 2.5;
	return undefined;
}

export function fastModeEvent(enabled: boolean, model: FastModeModel | undefined): FastModeEvent {
	const supported = isCodexFastModel(model);
	return {
		enabled,
		active: enabled && supported,
		supported,
		provider: model?.provider ?? "",
		modelId: model?.id ?? "",
		serviceTier: enabled && supported ? "priority" : "default",
	};
}
