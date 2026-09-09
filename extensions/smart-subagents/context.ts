import type { ParentMessage } from "./router.ts";

/** Only the active, compaction-aware view may be inherited by a worker. */
export interface ParentContextView {
	buildContextEntries(): readonly unknown[];
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((part) => {
		const item = record(part);
		return item?.type === "text" && typeof item.text === "string" ? [item.text] : [];
	}).join("\n");
}

export function collectParentMessages(sessionManager: ParentContextView): ParentMessage[] {
	const messages: ParentMessage[] = [];
	// Do not fall back to getBranch()/getEntries() or silently drop constraints
	// on failure: dispatch must fail instead of resurrecting summarized history.
	for (const value of sessionManager.buildContextEntries()) {
		const entry = record(value);
		if (!entry) continue;
		if ((entry.type === "compaction" || entry.type === "branch_summary") && typeof entry.summary === "string") {
			const label = entry.type === "compaction" ? "Compaction summary" : "Branch summary";
			if (entry.summary.trim()) messages.push({ role: "assistant", text: `[${label}]\n${entry.summary}` });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = record(entry.message);
		if (message?.role !== "user" && message?.role !== "assistant") continue;
		const text = textFromContent(message.content).trim();
		if (text) messages.push({ role: message.role, text });
	}
	return messages;
}

export function serializeMessages(messages: readonly ParentMessage[]): string {
	return messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text}`).join("\n\n");
}

/** Tail by UTF-16 character budget without splitting a surrogate pair. */
function tail(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	let start = Math.max(0, text.length - maxChars);
	const unit = text.charCodeAt(start);
	if (start > 0 && unit >= 0xdc00 && unit <= 0xdfff) start++;
	return text.slice(start);
}

/**
 * Keep recent evidence, not the start of a long conversation. If a large
 * assistant reply would displace the latest user instruction, reserve up to
 * half the available budget for that instruction and use the rest for the
 * following evidence. This is bounded text selection, not a model summary.
 */
export function boundedConversation(messages: readonly ParentMessage[], maxChars: number): string {
	if (!Number.isFinite(maxChars) || maxChars <= 0) return "";
	const limit = Math.floor(maxChars);
	const text = serializeMessages(messages);
	if (text.length <= limit) return text;
	const marker = "[Earlier content omitted]\n";
	if (limit <= marker.length + 16) return tail(text, limit);
	const budget = limit - marker.length;
	const userIndex = messages.findLastIndex((message) => message.role === "user");
	if (userIndex < 0 || serializeMessages(messages.slice(userIndex)).length <= budget) {
		return marker + tail(text, budget);
	}
	const user = messages[userIndex];
	const following = serializeMessages(messages.slice(userIndex + 1));
	if (!following) return marker + "User: " + tail(user.text, budget - 6);
	const userBudget = Math.floor((budget - 2) / 2);
	const pinnedUser = "User: " + tail(user.text, userBudget - 6);
	return marker + pinnedUser + "\n\n" + tail(following, budget - pinnedUser.length - 2);
}

export interface RoutingInputs {
	complexity?: string;
	contextMode?: string;
	permission?: string;
	model?: string;
	effort?: string;
}

/** Skip only when the advisor cannot change execution and no summary is needed. */
export function canSkipRoutingAdvisor(params: RoutingInputs): boolean {
	if (!["isolated", "selected", "full"].includes(params.contextMode ?? "")) return false;
	if (!["read-only", "workspace-write"].includes(params.permission ?? "")) return false;
	if (["simple", "medium", "complex", "critical"].includes(params.complexity ?? "")) return true;
	const explicitModel = typeof params.model === "string" && params.model.trim().length > 0 && params.model !== "auto";
	const explicitEffort = ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(params.effort ?? "");
	// Complexity can still be reported heuristically, but cannot affect a
	// fixed model+effort+context+permission. Missing authority is never guessed.
	return explicitModel && explicitEffort;
}
