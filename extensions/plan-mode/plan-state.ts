/**
 * Plan-mode persistent state: branch-aware custom markers plus the pure
 * decision logic used by exit_plan_mode in TUI / RPC / non-interactive modes.
 *
 * The marker entry is a custom session entry (does not reach the LLM). The
 * current branch is replayed newest-first on session_start so /reload, rewind
 * and /tree semantics all observe the same durable state; an inactive marker
 * always overrides an older active one.
 */

export const PLAN_MARKER_TYPE = "plan-mode-state-v1";

export type PlanMarkerState = "active" | "inactive";

export interface PlanMarker {
	state: PlanMarkerState;
	reason: string;
	source: string;
	timestamp: number;
}

export function buildPlanMarker(
	state: PlanMarkerState,
	reason: string,
	source: string,
	timestamp = Date.now(),
): PlanMarker {
	return {
		state,
		reason: String(reason ?? "").slice(0, 500),
		source: String(source ?? "").slice(0, 100),
		timestamp,
	};
}

export interface PlanBranchEntry {
	type?: unknown;
	customType?: unknown;
	data?: unknown;
}

/**
 * Reconstruct plan-mode state from a branch entry list. Scans newest→oldest
 * so the most recent marker wins; an inactive marker therefore overrides any
 * older active state.
 */
export function reconstructPlanState(entries: PlanBranchEntry[]): { active: boolean; reason: string } {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || typeof entry !== "object") continue;
		if (entry.type !== "custom" || entry.customType !== PLAN_MARKER_TYPE) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		const candidate = data as { state?: unknown; reason?: unknown };
		if (candidate.state === "active") {
			return { active: true, reason: typeof candidate.reason === "string" ? candidate.reason.slice(0, 500) : "" };
		}
		if (candidate.state === "inactive") return { active: false, reason: "" };
	}
	return { active: false, reason: "" };
}

// ---------------------------------------------------------------------------
// exit_plan_mode decision logic
// ---------------------------------------------------------------------------

export type PlanExitChannel = "tui" | "rpc" | "blocked";

/**
 * TUI uses the full custom approval UI; RPC uses confirm/input dialogs; every
 * other mode (json, print, unknown) is blocked and must fail closed — plan
 * mode is never auto-approved without an interactive user decision.
 */
export function planExitChannel(mode: string): PlanExitChannel {
	if (mode === "tui") return "tui";
	if (mode === "rpc") return "rpc";
	return "blocked";
}

export type RpcPlanExitOutcome = "approve" | "reject" | "feedback";

export function decideRpcPlanExit(
	confirmed: boolean,
	feedback?: string | null,
): { outcome: RpcPlanExitOutcome; text: string } {
	if (confirmed) {
		return {
			outcome: "approve",
			text: "User APPROVED the plan. Write tools are now unblocked. Proceed with implementation.",
		};
	}
	const trimmed = typeof feedback === "string" ? feedback.trim() : "";
	if (trimmed) {
		return {
			outcome: "feedback",
			text: `User provided feedback on the plan: "${trimmed}"\n\nRevise your plan accordingly and call exit_plan_mode again when ready.`,
		};
	}
	return {
		outcome: "reject",
		text: "User REJECTED the plan. Revise your approach. You are still in plan mode.",
	};
}

export function blockedPlanExitMessage(): string {
	return [
		"Plan mode is active and cannot be exited in this session mode.",
		"Write tools remain blocked. Approve the plan interactively in TUI or RPC mode instead.",
	].join(" ");
}

// ---------------------------------------------------------------------------
// Epoch guard — pure, testable session lifecycle guard
// ---------------------------------------------------------------------------

/**
 * Tracks a monotonic session epoch and a shutdown flag so that an awaited
 * `WebActivityRegistry.create()` cannot assign state or start timers after
 * `session_shutdown` (or a newer `session_start`) has already fired.
 *
 * Contract:
 * - `start()` increments the epoch and clears the shutdown flag; returns
 *   the new epoch number. Callers snapshot it BEFORE the await.
 * - `shutdown()` sets the shutdown flag; any snapshot taken before this
 *   point becomes stale.
 * - `isCurrent(epoch)` returns true only when the epoch matches AND the
 *   guard has not been shut down. Checked AFTER the await and BEFORE any
 *   assignment, timer start, or filesystem write.
 * - `start()` after `shutdown()` re-enables — this models /reload semantics
 *   where a new session_start fires after the previous shutdown.
 */
export class EpochGuard {
	private current = 0;
	private down = false;

	/** Begin a new session epoch. Returns the new epoch number. */
	start(): number {
		this.current += 1;
		this.down = false;
		return this.current;
	}

	/** Mark the current epoch as shut down; invalidates any prior snapshot. */
	shutdown(): void {
		this.down = true;
	}

	/** True only when `epoch` is the latest AND no shutdown has fired. */
	isCurrent(epoch: number): boolean {
		return epoch === this.current && !this.down;
	}

	/** Whether a shutdown has been signaled for the current epoch. */
	get isShutDown(): boolean {
		return this.down;
	}

	/** Current epoch number (0 before any start). */
	get value(): number {
		return this.current;
	}
}
