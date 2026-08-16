import type { ExtensionAPI, ExtensionCommandContext, ReplacedSessionContext } from "@earendil-works/pi-coding-agent";

export const MARKER_TYPE = "rewind-cursor";
const SUMMARY_LIMIT = 96;

type SessionEntryLike = {
	type: string;
	id: string;
	parentId: string | null;
	customType?: string;
	data?: unknown;
	message?: { role?: string; content?: unknown };
};

export type RewindMarker = {
	selectedEntryId: string;
	previousLeafId: string | null;
	targetParentId: string | null;
	createdAt: string;
};

/** Extract the textual part of a Pi message without copying attachments into state. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } =>
			!!part && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("");
}

/** Keep selector labels readable and deterministic while retaining the exact text separately. */
export function summarize(text: string, limit = SUMMARY_LIMIT): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (compact.length <= limit) return compact || "(empty message)";
	return `${compact.slice(0, Math.max(0, limit - 1))}…`;
}

export type RewindChoice = {
	entryId: string;
	text: string;
	option: string;
};

/** Build unique options from the active branch; reverse order makes the newest turn first. */
export function getRewindChoices(branch: readonly SessionEntryLike[]): RewindChoice[] {
	return branch
		.filter((entry) => entry.type === "message" && entry.message?.role === "user")
		.reverse()
		.map((entry, index) => {
			const text = contentText(entry.message?.content);
			// The ordinal and entry id make duplicate summaries unambiguous without changing
			// the text sent back to the editor. IDs are stable across reloads/tree branches.
			const option = `${index + 1}. ${summarize(text)}  [${entry.id}]`;
			return { entryId: entry.id, text, option };
		});
}

export function makeMarker(
	selectedEntryId: string,
	previousLeafId: string | null,
	targetParentId: string | null,
	createdAt = new Date().toISOString(),
): RewindMarker {
	return { selectedEntryId, previousLeafId, targetParentId, createdAt };
}

/** Recover composer text from a leaf marker without storing prompt text in the marker. */
export function markerRestoreText(
	leafId: string | null,
	getEntry: (id: string) => SessionEntryLike | undefined,
): string | undefined {
	if (!leafId) return undefined;
	const leaf = getEntry(leafId);
	if (!leaf || leaf.type !== "custom" || leaf.customType !== MARKER_TYPE) return undefined;
	const data = leaf.data;
	if (!data || typeof data !== "object") return undefined;
	const selectedEntryId = (data as { selectedEntryId?: unknown }).selectedEntryId;
	if (typeof selectedEntryId !== "string") return undefined;
	const selected = getEntry(selectedEntryId);
	if (!selected || selected.type !== "message" || selected.message?.role !== "user") return undefined;
	return contentText(selected.message.content);
}

function notify(ctx: Pick<ExtensionCommandContext, "ui">, message: string, type: "info" | "warning" | "error" = "warning"): void {
	ctx.ui.notify(message, type);
}

function isSafeToRewind(ctx: ExtensionCommandContext): boolean {
	// isIdle() covers streaming, retries, compaction, and queued continuations. Keep the
	// explicit pending check as a guard for runtimes whose idle state lags queue updates.
	if (!ctx.isIdle() || ctx.hasPendingMessages()) {
		notify(ctx, "Pi is busy (streaming, compacting, or has pending messages). Wait, then run /rewind.");
		return false;
	}
	return true;
}

async function restoreAfterReplacement(ctx: ReplacedSessionContext, text: string): Promise<void> {
	// This callback runs after the old runtime has been torn down. Never use the old
	// command context here: same-file switch creates a fresh session-bound context.
	ctx.ui.setEditorText(text);
}

export default function (pi: ExtensionAPI): void {
	// If a process is later resumed while the marker is still the leaf, derive the
	// composer text from the referenced historical entry. Once a new user message is
	// appended, the marker is no longer the leaf and this is intentionally a no-op.
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		const text = markerRestoreText(
			ctx.sessionManager.getLeafId(),
			(id) => ctx.sessionManager.getEntry(id) as SessionEntryLike | undefined,
		);
		if (text !== undefined) ctx.ui.setEditorText(text);
	});

	pi.registerCommand("rewind", {
		description: "Backtrack to a user turn without reverting workspace files",
		handler: async (args, ctx) => {
			if (args.trim()) {
				notify(ctx, "Usage: /rewind (no arguments)");
				return;
			}
			if (!isSafeToRewind(ctx)) return;
			if (!ctx.hasUI) {
				notify(ctx, "Rewind needs an interactive TUI or Web/RPC UI.", "info");
				return;
			}

			const choices = getRewindChoices(ctx.sessionManager.getBranch() as SessionEntryLike[]);
			if (choices.length === 0) {
				notify(ctx, "No user turns on the current branch.", "info");
				return;
			}

			const selectedOption = await ctx.ui.select(
				"Rewind to which user turn? (latest first)",
				choices.map((choice) => choice.option),
			);
			if (selectedOption === undefined) return;
			const selected = choices.find((choice) => choice.option === selectedOption);
			if (!selected) {
				notify(ctx, "The selected rewind turn is no longer available; no changes made.", "error");
				return;
			}

			const target = ctx.sessionManager.getEntry(selected.entryId) as SessionEntryLike | undefined;
			if (!target || target.type !== "message" || target.message?.role !== "user") {
				notify(ctx, "The selected rewind turn is no longer available; no changes made.", "error");
				return;
			}

			const previousLeafId = ctx.sessionManager.getLeafId();
			const targetParentId = target.parentId;
			const sessionFile = ctx.sessionManager.getSessionFile();

			try {
				const navigation = await ctx.navigateTree(selected.entryId);
				if (navigation.cancelled) return;

				// Append only opaque cursor metadata. Custom entries are excluded from LLM
				// context, and this intentionally does not contain the prompt text.
				pi.appendEntry(MARKER_TYPE, makeMarker(selected.entryId, previousLeafId, targetParentId));
			} catch (error) {
				notify(ctx, `Rewind failed: ${error instanceof Error ? error.message : String(error)}`, "error");
				return;
			}

			if (!sessionFile) {
				// Ephemeral sessions have no file to reopen; navigateTree already rebuilt
				// the agent context, so only restore the editor on the current runtime.
				ctx.ui.setEditorText(selected.text);
				return;
			}

			try {
				const result = await ctx.switchSession(sessionFile, {
					withSession: async (replacementCtx) => {
						await restoreAfterReplacement(replacementCtx, selected.text);
					},
				});
				if (result.cancelled) {
					// No replacement occurred, so the original context remains valid.
					ctx.ui.setEditorText(selected.text);
					notify(ctx, "Session refresh was cancelled; rewind state is still active.", "info");
				}
			} catch (error) {
				// switchSession may have torn down this context before reporting an
				// error. Do not touch captured UI/session objects in this path.
				console.error(`[rewind] same-file session refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	});
}
