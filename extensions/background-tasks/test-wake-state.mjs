import assert from "node:assert/strict";
import test from "node:test";
import {
	BACKGROUND_WAKE_MARKER_TYPE,
	acknowledgedWakeMarker,
	pendingWakeMarker,
	reconstructWakeOutbox,
} from "./wake-state.ts";

function run(id = "bg-one", overrides = {}) {
	return {
		recordVersion: 2,
		id,
		taskId: `task-${id}`,
		name: id,
		status: "failed",
		cwd: "/work",
		createdAt: 10,
		startedAt: 10,
		finishedAt: 20,
		timeoutAt: 100,
		terminationReason: "exit_nonzero",
		exitCode: 2,
		stdoutTail: "",
		stderrTail: "bad",
		stdoutPath: `/runs/${id}/stdout.log`,
		stderrPath: `/runs/${id}/stderr.log`,
		resultPath: `/runs/${id}/result.json`,
		logTruncated: false,
		...overrides,
	};
}

const markerEntry = (data) => ({ type: "custom", customType: BACKGROUND_WAKE_MARKER_TYPE, data });
const completionEntry = (...runs) => ({
	type: "custom_message",
	customType: "background-task-completion",
	details: { runs, wakeRunIds: runs.map((item) => item.id) },
});
const assistantEntry = (stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason } });

test("pending terminal wake survives reconstruction and duplicate markers remain idempotent", () => {
	const terminal = run();
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(terminal, 30)),
		markerEntry(pendingWakeMarker({ ...terminal, error: "newest" }, 40)),
	]);
	assert.deepEqual([...state.pending.keys()], [terminal.id]);
	assert.equal(state.pending.get(terminal.id).error, "newest");
	assert.equal(state.knownRunIds.has(terminal.id), true);
});

test("explicit acknowledgement prevents restart replay", () => {
	const terminal = run();
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(terminal, 30)),
		completionEntry(terminal),
		assistantEntry(),
		markerEntry(acknowledgedWakeMarker(terminal.id, 50)),
	]);
	assert.equal(state.pending.size, 0);
	assert.equal(state.implicitlyAcknowledged.size, 0);
});

test("successful persisted response closes the crash window before explicit ack", () => {
	const terminal = run();
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(terminal, 30)),
		completionEntry(terminal),
		assistantEntry("stop"),
	]);
	assert.equal(state.pending.size, 0);
	assert.deepEqual([...state.implicitlyAcknowledged], [terminal.id]);
});

test("provider error does not acknowledge a durable wake and is safely replayable", () => {
	const terminal = run();
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(terminal, 30)),
		completionEntry(terminal),
		assistantEntry("error"),
	]);
	assert.deepEqual([...state.pending.keys()], [terminal.id]);
	assert.equal(state.implicitlyAcknowledged.size, 0);
});

test("coalesced wake acknowledges exactly the run ids carried by the completion message", () => {
	const one = run("bg-one");
	const two = run("bg-two", { taskId: "task-two" });
	const three = run("bg-three", { taskId: "task-three" });
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(one, 30)),
		markerEntry(pendingWakeMarker(two, 31)),
		markerEntry(pendingWakeMarker(three, 32)),
		completionEntry(one, two),
		assistantEntry(),
	]);
	assert.deepEqual([...state.pending.keys()], [three.id]);
	assert.deepEqual([...state.implicitlyAcknowledged].sort(), [one.id, two.id]);
});
