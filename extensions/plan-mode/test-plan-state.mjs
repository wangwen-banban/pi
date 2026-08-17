import assert from "node:assert/strict";
import test from "node:test";
import {
	PLAN_MARKER_TYPE,
	blockedPlanExitMessage,
	buildPlanMarker,
	decideRpcPlanExit,
	planExitChannel,
	reconstructPlanState,
} from "./plan-state.ts";

function entry(customType, data) {
	return { type: "custom", customType, data };
}

const marker = (state, reason = "", source = "enter") =>
	entry(PLAN_MARKER_TYPE, buildPlanMarker(state, reason, source, 1000));

test("buildPlanMarker bounds fields and records state", () => {
	const value = buildPlanMarker("active", "r".repeat(2000), "s".repeat(500), 42);
	assert.equal(value.state, "active");
	assert.equal(value.reason.length, 500);
	assert.equal(value.source.length, 100);
	assert.equal(value.timestamp, 42);
});

test("branch replay reconstructs the newest marker state", () => {
	// No markers → inactive.
	assert.deepEqual(reconstructPlanState([]), { active: false, reason: "" });
	// Active wins when it is the only marker.
	assert.deepEqual(reconstructPlanState([marker("active", "reason-x")]), { active: true, reason: "reason-x" });
	// Inactive marker overrides an older active marker.
	assert.deepEqual(reconstructPlanState([marker("active", "old"), marker("inactive")]), { active: false, reason: "" });
	// A newer active marker re-activates.
	assert.deepEqual(reconstructPlanState([marker("inactive"), marker("active", "again")]), { active: true, reason: "again" });
	// Unrelated entries (messages, other custom types, malformed data) are ignored.
	assert.deepEqual(
		reconstructPlanState([
			{ type: "message", message: {} },
			entry("other-state", { state: "active" }),
			entry(PLAN_MARKER_TYPE, null),
			entry(PLAN_MARKER_TYPE, "not-an-object"),
			marker("active", "real"),
			entry(PLAN_MARKER_TYPE, { state: "unknown" }),
			marker("active", "ignored-older"),
			marker("inactive"),
		]),
		{ active: false, reason: "" },
	);
	// Enter → approve → manual off round trip ends inactive.
	assert.deepEqual(
		reconstructPlanState([marker("active", "r", "enter"), marker("inactive", "", "approve"), marker("inactive", "", "manual_off")]),
		{ active: false, reason: "" },
	);
});

test("reconstruction is branch-tail sensitive for rewind semantics", () => {
	// A truncated branch (rewind) whose tail ends in an active marker stays active.
	const full = [marker("active", "a"), marker("inactive"), marker("active", "b")];
	assert.deepEqual(reconstructPlanState(full), { active: true, reason: "b" });
	assert.deepEqual(reconstructPlanState(full.slice(0, 1)), { active: true, reason: "a" });
	assert.deepEqual(reconstructPlanState(full.slice(0, 2)), { active: false, reason: "" });
});

test("planExitChannel only allows interactive modes", () => {
	assert.equal(planExitChannel("tui"), "tui");
	assert.equal(planExitChannel("rpc"), "rpc");
	assert.equal(planExitChannel("json"), "blocked");
	assert.equal(planExitChannel("print"), "blocked");
	assert.equal(planExitChannel("headless"), "blocked");
	assert.equal(planExitChannel(""), "blocked");
});

test("decideRpcPlanExit: approve / reject / feedback; never auto-approve", () => {
	const approve = decideRpcPlanExit(true);
	assert.equal(approve.outcome, "approve");
	assert.match(approve.text, /APPROVED/);

	const reject = decideRpcPlanExit(false, null);
	assert.equal(reject.outcome, "reject");
	assert.match(reject.text, /REJECTED/);

	const emptyFeedback = decideRpcPlanExit(false, "   ");
	assert.equal(emptyFeedback.outcome, "reject");

	const feedback = decideRpcPlanExit(false, "use a smaller scope");
	assert.equal(feedback.outcome, "feedback");
	assert.match(feedback.text, /use a smaller scope/);

	// Cancelled confirmation (false) with no feedback stays in plan mode.
	const cancelled = decideRpcPlanExit(false, undefined);
	assert.equal(cancelled.outcome, "reject");
});

test("blocked channels fail closed with an actionable message", () => {
	const message = blockedPlanExitMessage();
	assert.match(message, /cannot be exited/);
	assert.match(message, /remain blocked/);
});
