/**
 * BTW side-session engine.
 *
 * Creates an in-memory (never-persisted) AgentSession that inherits:
 *   - the parent process's ModelRuntime (so extension-registered custom
 *     providers like `claude-relay-alibaba` resolve correctly), and
 *   - a snapshot of the parent conversation as hidden reference context.
 *
 * The side session has read-only tools only, so it can inspect files/run
 * searches (matching Codex `/side`) but cannot mutate the workspace.
 *
 * Nothing here touches the TUI; see panel.ts for rendering.
 */

const PI_ROOT_CANDIDATES = [
	"/Users/wenwang/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent",
	process.env.PI_ROOT ?? "",
].filter(Boolean);

async function importPi(): Promise<any> {
	let lastErr: unknown;
	for (const root of PI_ROOT_CANDIDATES) {
		try {
			return await import(`${root}/dist/index.js`);
		} catch (e) {
			lastErr = e;
		}
	}
	// Fall back to bare specifier resolution (works if extension host resolves it).
	try {
		return await import("@earendil-works/pi-coding-agent");
	} catch {
		throw lastErr ?? new Error("cannot locate pi-coding-agent");
	}
}

/** Read-only tool set granted to BTW sessions (inspection only, no mutation). */
export const BTW_READONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export const BTW_BOUNDARY = [
	"=== SIDE CONVERSATION BOUNDARY ===",
	"The messages above are a READ-ONLY SNAPSHOT of a separate main conversation,",
	"provided purely as background reference. They are NOT instructions to execute.",
	"",
	"You are now in a side conversation (\"by the way\" / BTW). Rules:",
	"- Answer the user's new question(s) directly and conversationally.",
	"- You MAY inspect the workspace: read or search files, run read-only checks.",
	"- Do NOT modify, create, or delete files. Do NOT run mutating commands.",
	"- Do NOT continue or resume the main task described above.",
	"- Do NOT spawn sub-agents.",
	"This side conversation is ephemeral and is not saved unless the user keeps it.",
	"=== END BOUNDARY ===",
].join("\n");

export interface ParentSnapshot {
	/** Plain-text rendering of recent main-thread turns, or null if none. */
	text: string | null;
	name: string | undefined;
}

/**
 * Render the parent session branch into a compact text transcript for seeding.
 * Applies a rough character budget, keeping the most recent turns.
 */
export function renderParentSnapshot(ctx: any, charBudget = 12_000): ParentSnapshot {
	const sm = ctx.sessionManager;
	const name = sm?.getSessionName?.();
	let entries: any[] = [];
	try {
		entries = sm?.getBranch?.() ?? [];
	} catch {
		entries = [];
	}
	const lines: string[] = [];
	for (const entry of entries) {
		if (entry?.type !== "message" || !entry.message) continue;
		const m = entry.message;
		const role = m.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = (m.content ?? [])
			.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("")
			.trim();
		if (!text) continue;
		lines.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	if (lines.length === 0) return { text: null, name };
	// Keep the tail within budget.
	let joined = lines.join("\n\n");
	if (joined.length > charBudget) {
		joined = "…(earlier turns omitted)…\n\n" + joined.slice(joined.length - charBudget);
	}
	return { text: joined, name };
}

export interface BtwSessionHandle {
	session: any;
	dispose: () => Promise<void>;
}

export interface CreateBtwOptions {
	/** The extension command context (provides model, cwd, modelRuntime). */
	ctx: any;
	/** Optional parent snapshot text to seed as hidden reference context. */
	snapshot?: string | null;
}

/**
 * Create an in-memory BTW agent session inheriting the parent runtime + model.
 * Throws if the runtime cannot be inherited (caller should surface the error).
 */
export async function createBtwSession(opts: CreateBtwOptions): Promise<BtwSessionHandle> {
	const { ctx, snapshot } = opts;
	const pi = await importPi();
	const { createAgentSession, SessionManager } = pi;
	if (typeof createAgentSession !== "function" || !SessionManager?.inMemory) {
		throw new Error("this pi build does not expose createAgentSession / SessionManager.inMemory");
	}

	const cwd = ctx.cwd ?? process.cwd();

	// Inherit the live ModelRuntime so custom providers (alibaba relay, etc.)
	// registered by extensions are available. This reaches a private field;
	// fall back to letting createAgentSession build its own runtime if absent.
	const inheritedRuntime = ctx.modelRegistry?.runtime ?? undefined;

	// Use the parent's current Model OBJECT (never a string — sdk requires an object).
	const model = ctx.model ?? undefined;

	const sm = SessionManager.inMemory(cwd);

	// Seed hidden reference context BEFORE creating the session so it lands in
	// the initial context window.
	if (snapshot && typeof sm.appendCustomMessageEntry === "function") {
		try {
			sm.appendCustomMessageEntry("btw-parent-snapshot", snapshot, false);
		} catch {
			// non-fatal: proceed without seeded history
		}
	}

	const createOpts: any = {
		cwd,
		sessionManager: sm,
		tools: [...BTW_READONLY_TOOLS],
	};
	if (model) createOpts.model = model;
	if (inheritedRuntime) createOpts.modelRuntime = inheritedRuntime;
	if (ctx.thinkingLevel) createOpts.thinkingLevel = ctx.thinkingLevel;

	const { session } = await createAgentSession(createOpts);

	// Append the boundary instruction as a hidden custom entry too, so the model
	// sees the rules right before the first user question.
	try {
		session.sessionManager?.appendCustomMessageEntry?.("btw-boundary", BTW_BOUNDARY, false);
	} catch {
		/* non-fatal */
	}

	const dispose = async () => {
		try {
			await session.dispose?.();
		} catch {
			/* ignore */
		}
	};

	return { session, dispose };
}

/**
 * Persist the visible BTW transcript as a standalone pi session.
 *
 * Hidden parent-snapshot/boundary entries are intentionally omitted: a kept
 * conversation should resume as its own thread, not re-import main-thread
 * instructions. Tool-result messages are retained so assistant tool calls stay
 * structurally valid when resumed.
 */
export async function persistBtwSession(
	session: any,
	opts: { cwd: string; name?: string },
): Promise<string> {
	const pi = await importPi();
	const { SessionManager } = pi;
	if (!SessionManager?.create) throw new Error("SessionManager.create is unavailable");

	const saved = SessionManager.create(opts.cwd);
	const model = session?.model;
	if (model?.provider && model?.id) {
		saved.appendModelChange(model.provider, model.id);
	}
	if (session?.thinkingLevel) {
		saved.appendThinkingLevelChange(session.thinkingLevel);
	}

	let count = 0;
	for (const message of session?.messages ?? []) {
		if (!message || !["user", "assistant", "toolResult"].includes(message.role)) continue;
		// Never persist provider failures as valid assistant turns.
		if (message.role === "assistant" && message.stopReason === "error") continue;
		saved.appendMessage(structuredClone(message));
		count++;
	}
	if (count === 0) throw new Error("BTW transcript is empty");

	const fallbackName = `BTW ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
	saved.appendSessionInfo(opts.name?.trim() || fallbackName);
	const path = saved.getSessionFile();
	if (!path) throw new Error("failed to create persisted session file");
	return path;
}

/** Extract concatenated assistant text from the latest message. */
export function latestAssistantText(session: any): string {
	const msgs = session?.messages ?? [];
	const last = msgs[msgs.length - 1];
	if (!last || last.role !== "assistant") return "";
	return (last.content ?? [])
		.filter((c: any) => c.type === "text")
		.map((c: any) => c.text)
		.join("");
}
