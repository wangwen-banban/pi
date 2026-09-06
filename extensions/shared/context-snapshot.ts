import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type SnapshotSessionManager = Pick<ExtensionContext["sessionManager"], "buildContextEntries">;

/**
 * Append changing extension state to the conversation, never to systemPrompt.
 *
 * Deduplicate against the latest snapshot in the *active, compaction-aware*
 * context. A process-local "last sent" variable would incorrectly suppress
 * state after /tree, resume, compaction, or an aborted prompt preflight.
 * Plain custom entries are persistence markers, not model-visible messages.
 */
export function contextSnapshotResult(
	sessionManager: SnapshotSessionManager,
	customType: string,
	content: string,
): BeforeAgentStartEventResult {
	let entries: ReturnType<SnapshotSessionManager["buildContextEntries"]>;
	try {
		entries = sessionManager.buildContextEntries();
	} catch {
		// Prefer one redundant snapshot over silently omitting current state.
		// Do not fall back to getEntries()/getBranch(): summarized or off-branch
		// snapshots are not proof that the model can still see the state.
		entries = [];
	}

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		const message = entry.type === "custom_message"
			? entry
			: entry.type === "message" && entry.message.role === "custom"
				? entry.message
				: undefined;
		if (!message || message.customType !== customType) continue;
		if (message.content === content) return {};
		// Only the latest matching snapshot counts, including A -> B -> A.
		break;
	}

	return {
		message: {
			customType,
			content,
			display: false,
		},
	};
}

/**
 * Register append-only snapshots for normal prompts and compaction recovery.
 * Pi 0.84.1 provides buildContextEntries() on its read-only session manager.
 *
 * before_agent_start messages are appended by Pi after the new user message.
 * Compaction may immediately retry via agent.continue(), without firing that
 * hook again, so restore a removed/changed snapshot in session_compact too.
 * Neither hook changes tool permissions, rewrites history, or starts a turn.
 */
export function registerContextSnapshot(
	pi: ExtensionAPI,
	customType: string,
	getContent: () => string,
): void {
	const snapshot = (ctx: ExtensionContext) =>
		contextSnapshotResult(ctx.sessionManager, customType, getContent());

	pi.on("before_agent_start", (_event, ctx) => snapshot(ctx));
	pi.on("session_compact", (_event, ctx) => {
		const { message } = snapshot(ctx);
		if (message) {
			// Not "nextTurn": overflow recovery can continue before a new prompt.
			// triggerTurn:false is essential: restoration must not call the model.
			pi.sendMessage(message, { triggerTurn: false });
		}
	});
}
