/**
 * Session Sync — pick up external session changes without quitting the TUI.
 *
 * Problem: when a phone/web client (PI WEB) appends to the same session
 * file, a still-open local TUI holds stale in-memory state. Typing in the
 * stale TUI branches from an old position, forking the session tree.
 *
 * Solution:
 *   /sync — re-read the session file from disk via ctx.switchSession(same
 *           path), landing on the latest leaf (including messages written
 *           by phone/web clients). Extensions rebind automatically.
 *
 * A background watcher also detects external file growth (phone writing
 * while the local TUI is idle) and shows a persistent warning widget so
 * you know to run /sync before typing.
 *
 * Only active in TUI mode; RPC/print/JSON modes are unaffected.
 */

import { statSync } from "node:fs";

const POLL_INTERVAL_MS = 3000;
const QUIET_PERIOD_MS = 4000;
const WIDGET_KEY = "session-drift";
/** Minimum byte growth to consider external (avoids metadata jitter). */
const MIN_DRIFT_BYTES = 16;

export interface SessionSyncOptions {
	pollIntervalMs?: number;
	quietPeriodMs?: number;
	minDriftBytes?: number;
}

/** Events that indicate the local session is actively working or changing persisted session state. */
const LOCAL_ACTIVITY_EVENTS = [
	"agent_start",
	"turn_start",
	"message_start",
	"message_update",
	"message_end",
	"turn_end",
	"tool_execution_start",
	"tool_execution_end",
	"compaction_start",
	"compaction_end",
	"auto_retry_start",
	"auto_retry_end",
	"model_select",
	"thinking_level_select",
] as const;

/** Background lifecycle channels append local custom entries while the TUI is otherwise quiet. */
const LOCAL_ACTIVITY_CHANNELS = [
	"smart-subagent:completed",
	"smart-subagent:failed",
	"smart-subagent:stopped",
	"background-task:completed",
	"background-task:failed",
	"background-task:stopped",
] as const;

type ResolvedSessionSyncOptions = Required<SessionSyncOptions>;

export function createSessionSyncExtension(options: SessionSyncOptions = {}) {
	const resolvedOptions: ResolvedSessionSyncOptions = {
		pollIntervalMs: options.pollIntervalMs ?? POLL_INTERVAL_MS,
		quietPeriodMs: options.quietPeriodMs ?? QUIET_PERIOD_MS,
		minDriftBytes: options.minDriftBytes ?? MIN_DRIFT_BYTES,
	};
	return function sessionSync(pi: ExtensionAPI) {
		registerSessionSync(pi, resolvedOptions);
	};
}

function registerSessionSync(
	pi: ExtensionAPI,
	{ pollIntervalMs, quietPeriodMs, minDriftBytes }: ResolvedSessionSyncOptions,
) {
	let sessionFile: string | undefined;
	let baselineSize = 0;
	let lastLocalActivity = Date.now();
	let needsBaselineRefresh = true;
	let driftNotified = false;
	let pollTimer: ReturnType<typeof setInterval> | undefined;
	/** Latest extension context for UI updates from the poll timer. */
	let uiCtx: ExtensionCommandContext["ui"] | undefined;

	function clearWarning(): void {
		if (!driftNotified) return;
		driftNotified = false;
		try {
			uiCtx?.setWidget(WIDGET_KEY, undefined);
		} catch {
			// UI may be unavailable during shutdown; safe to ignore.
		}
	}

	function refreshBaseline(): void {
		if (!sessionFile) return;
		try {
			baselineSize = statSync(sessionFile).size;
			needsBaselineRefresh = false;
			lastLocalActivity = Date.now();
			clearWarning();
		} catch {
			// File may not exist yet for brand-new sessions.
		}
	}

	function poll(): void {
		if (!sessionFile) return;
		try {
			const size = statSync(sessionFile).size;
			const isQuiet = Date.now() - lastLocalActivity >= quietPeriodMs;

			if (needsBaselineRefresh || !isQuiet) {
				// Local activity or first poll: accept current size as baseline.
				baselineSize = size;
				needsBaselineRefresh = false;
			} else if (size > baselineSize + minDriftBytes && !driftNotified) {
				// File grew while local TUI was quiet → external client wrote.
				driftNotified = true;
				try {
					uiCtx?.setWidget(WIDGET_KEY, [
						"  ┌─────────────────────────────────────────────────────┐",
						"  │  ⚠  Session was modified externally (phone/web).    │",
						"  │                                                     │",
						"  │  Run /sync to reload the latest state.              │",
						"  │  Typing here now will branch from a stale position. │",
						"  └─────────────────────────────────────────────────────┘",
					]);
				} catch {
					// Non-TUI mode or shutdown; widget is unavailable.
				}
			}

			// Always advance baseline so we only detect new growth.
			baselineSize = size;
		} catch {
			// File deleted or inaccessible; skip this cycle.
		}
	}

	// ── Lifecycle ────────────────────────────────────────────────

	pi.on("session_start", (_event, ctx) => {
		sessionFile = ctx.sessionManager.getSessionFile();
		// Only enable polling in interactive TUI mode.
		if (ctx.mode !== "tui") return;
		uiCtx = ctx.ui;
		refreshBaseline();
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = setInterval(poll, pollIntervalMs);
		pollTimer.unref?.();
	});

	pi.on("session_shutdown", () => {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
		uiCtx = undefined;
		sessionFile = undefined;
	});

	// ── Local activity tracking ─────────────────────────────────

	const recordLocalActivity = () => {
		lastLocalActivity = Date.now();
		needsBaselineRefresh = true;
		clearWarning();
	};
	for (const eventType of LOCAL_ACTIVITY_EVENTS) {
		pi.on(eventType, recordLocalActivity);
	}
	for (const channel of LOCAL_ACTIVITY_CHANNELS) {
		pi.events.on(channel, recordLocalActivity);
	}

	// ── /sync command ────────────────────────────────────────────

	pi.registerCommand("sync", {
		description: "Reload session from disk (pick up phone/web changes without quitting)",
		handler: async (_args, ctx) => {
			const file = ctx.sessionManager.getSessionFile();
			if (!file) {
				ctx.ui.notify("No session file to sync (ephemeral session?).", "warning");
				return;
			}

			// Refuse while agent is working — switchSession during active work
			// would abort the current turn and potentially lose output.
			if (!ctx.isIdle()) {
				ctx.ui.notify("Agent is busy. Wait for it to finish, then /sync.", "warning");
				return;
			}

			ctx.ui.notify("Reloading session from disk…", "info");
			// switchSession to the same path performs a full runtime
			// replacement: re-reads the JSONL file, rebuilds the session
			// tree, and lands on the latest leaf. Extensions rebind via
			// session_shutdown → session_start(reason: "resume").
			await ctx.switchSession(file);
		},
	});
}

export default createSessionSyncExtension();
