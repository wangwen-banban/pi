import assert from "node:assert/strict";
import test from "node:test";
import {
	BACKGROUND_WAKE_MARKER_TYPE,
	acknowledgedWakeMarker,
	deliveryWakeMarker,
	parseBackgroundWakeMarker,
	pendingWakeMarker,
	reconstructWakeOutbox,
} from "./wake-state.ts";
import { BACKGROUND_RUN_RECORD_VERSION } from "./run-persistence.ts";

const sessionId = "session-test";

function terminal(runId = "bg-one", taskId = "task-one", overrides = {}) {
	const now = Date.now();
	return {
		version: BACKGROUND_RUN_RECORD_VERSION,
		sessionId,
		runId,
		taskId,
		status: "failed",
		createdAt: now - 100,
		startedAt: now - 100,
		finishedAt: now - 10,
		timeoutAt: now + 1_000,
		terminationReason: "exit_nonzero",
		exitCode: 2,
		...overrides,
	};
}

const markerEntry = (data) => ({ type: "custom", customType: BACKGROUND_WAKE_MARKER_TYPE, data });
const unrelatedAssistant = (stopReason = "stop") => ({ type: "message", message: { role: "assistant", stopReason } });

function delivery(attempt, items, id = `wake-${String(attempt).padStart(48, "a")}`) {
	return deliveryWakeMarker(sessionId, id, attempt, items);
}

test("pending terminal wake survives reconstruction without private run data", () => {
	const record = terminal();
	const marker = pendingWakeMarker(record, 7);
	const serialized = JSON.stringify(marker);
	for (const forbidden of ["command", "stdout", "stderr", "cwd", "path", "pid", "output", "title", "credential"]) {
		assert.equal(serialized.toLowerCase().includes(forbidden), false);
	}
	const state = reconstructWakeOutbox([markerEntry(marker)], sessionId);
	assert.deepEqual([...state.pending.keys()], [record.runId]);
	assert.equal(state.pending.get(record.runId).sequence, 7);
	assert.equal(state.nextSequence, 8);
});

test("pending, delivery and ack permutations are interpreted only in branch order", () => {
	const record = terminal();
	const pending = pendingWakeMarker(record, 1);
	const sent = delivery(1, [{ runId: record.runId, sequence: 1 }]);
	const ack = acknowledgedWakeMarker(sent);
	const markers = { pending, delivery: sent, ack };
	const permutations = [
		["pending", "delivery", "ack"],
		["pending", "ack", "delivery"],
		["delivery", "pending", "ack"],
		["delivery", "ack", "pending"],
		["ack", "pending", "delivery"],
		["ack", "delivery", "pending"],
	];
	for (const order of permutations) {
		const state = reconstructWakeOutbox(order.map((kind) => markerEntry(markers[kind])), sessionId);
		const validOrder = order.join(",") === "pending,delivery,ack";
		assert.equal(state.pending.has(record.runId), !validOrder, order.join("→"));
		assert.equal(state.acknowledged.size, validOrder ? 1 : 0, order.join("→"));
		assert.equal(state.invalidMarkerCount > 0, !validOrder, order.join("→"));
	}
});

test("an invalid delivery-before-pending chain cannot retroactively ack, but a later legal chain can", () => {
	const record = terminal();
	const early = delivery(1, [{ runId: record.runId, sequence: 1 }]);
	const pending = pendingWakeMarker(record, 1);
	const earlyAck = acknowledgedWakeMarker(early);
	const invalidOnly = reconstructWakeOutbox([
		markerEntry(early),
		markerEntry(pending),
		markerEntry(earlyAck),
	], sessionId);
	assert.equal(invalidOnly.pending.has(record.runId), true);
	assert.equal(invalidOnly.acknowledged.size, 0);
	assert.ok(invalidOnly.invalidMarkerCount > 0);

	const later = delivery(2, [{ runId: record.runId, sequence: 1 }]);
	const recovered = reconstructWakeOutbox([
		markerEntry(early),
		markerEntry(pending),
		markerEntry(earlyAck),
		markerEntry(later),
		markerEntry(acknowledgedWakeMarker(later)),
	], sessionId);
	assert.equal(recovered.pending.size, 0);
	assert.equal(recovered.acknowledged.has(record.runId), true);
	assert.ok(recovered.invalidMarkerCount >= 2);
});

test("only a matching explicit acknowledgement closes a delivery", () => {
	const record = terminal();
	const pending = pendingWakeMarker(record, 3);
	const sent = delivery(4, [{ runId: record.runId, sequence: 3 }]);
	const beforeAck = reconstructWakeOutbox([
		markerEntry(pending),
		markerEntry(sent),
		unrelatedAssistant("stop"),
	], sessionId);
	assert.equal(beforeAck.pending.has(record.runId), true, "assistant success never implies ack");
	const afterAck = reconstructWakeOutbox([
		markerEntry(pending),
		markerEntry(sent),
		markerEntry(acknowledgedWakeMarker(sent)),
	], sessionId);
	assert.equal(afterAck.pending.size, 0);
	assert.equal(afterAck.acknowledged.get(record.runId).terminationReason, "exit_nonzero");
	assert.equal(afterAck.knownRunIds.has(record.runId), true);
});

test("toolUse, error, aborted, length and later unrelated success never imply ack", () => {
	const record = terminal();
	const pending = pendingWakeMarker(record, 1);
	const sent = delivery(1, [{ runId: record.runId, sequence: 1 }]);
	for (const stopReason of ["toolUse", "error", "aborted", "length"]) {
		const state = reconstructWakeOutbox([
			markerEntry(pending),
			markerEntry(sent),
			unrelatedAssistant(stopReason),
			unrelatedAssistant("stop"),
		], sessionId);
		assert.equal(state.pending.has(record.runId), true);
	}
});

test("mismatched delivery, sequence, attempt or session cannot acknowledge", () => {
	const record = terminal();
	const pending = pendingWakeMarker(record, 2);
	const sent = delivery(5, [{ runId: record.runId, sequence: 2 }]);
	const wrongAttempt = { ...acknowledgedWakeMarker(sent), attempt: 6 };
	const wrongSequence = { ...acknowledgedWakeMarker(sent), items: [{ runId: record.runId, sequence: 1 }] };
	const wrongSession = { ...acknowledgedWakeMarker(sent), sessionId: "other-session" };
	for (const ack of [wrongAttempt, wrongSequence, wrongSession]) {
		const state = reconstructWakeOutbox([markerEntry(pending), markerEntry(sent), markerEntry(ack)], sessionId);
		assert.equal(state.pending.has(record.runId), true);
		assert.ok(state.invalidMarkerCount >= 1);
	}
});

test("coalesced ack affects exactly the delivered run ids and sequences", () => {
	const one = terminal("bg-one", "task-one");
	const two = terminal("bg-two", "task-two");
	const three = terminal("bg-three", "task-three");
	const sent = delivery(8, [
		{ runId: one.runId, sequence: 10 },
		{ runId: two.runId, sequence: 11 },
	]);
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(one, 10)),
		markerEntry(pendingWakeMarker(two, 11)),
		markerEntry(pendingWakeMarker(three, 12)),
		markerEntry(sent),
		markerEntry(acknowledgedWakeMarker(sent)),
	], sessionId);
	assert.deepEqual([...state.pending.keys()], [three.runId]);
	assert.equal(state.maxAttempt, 8);
});

test("a newer pending sequence cannot be erased by an older ack", () => {
	const record = terminal();
	const oldDelivery = delivery(1, [{ runId: record.runId, sequence: 1 }]);
	const state = reconstructWakeOutbox([
		markerEntry(pendingWakeMarker(record, 1)),
		markerEntry(oldDelivery),
		markerEntry(pendingWakeMarker(record, 2)),
		markerEntry(acknowledgedWakeMarker(oldDelivery)),
	], sessionId);
	assert.equal(state.pending.get(record.runId).sequence, 2);
	assert.equal(state.acknowledged.size, 0);
	assert.ok(state.invalidMarkerCount >= 1);
});

test("duplicate and regressing markers are invalid without poisoning a later valid ack", () => {
	const record = terminal();
	const pending = pendingWakeMarker(record, 2);
	const sent = delivery(2, [{ runId: record.runId, sequence: 2 }]);
	const state = reconstructWakeOutbox([
		markerEntry(pending),
		markerEntry(pending),
		markerEntry(sent),
		markerEntry(sent),
		markerEntry(delivery(1, [{ runId: record.runId, sequence: 2 }])),
		markerEntry(acknowledgedWakeMarker(sent)),
		markerEntry(acknowledgedWakeMarker(sent)),
	], sessionId);
	assert.equal(state.pending.size, 0);
	assert.equal(state.acknowledged.has(record.runId), true);
	assert.ok(state.invalidMarkerCount >= 4);
	assert.equal(state.nextSequence, 3);
	assert.equal(state.maxAttempt, 2);
});

test("cross-run, cross-sequence, cross-session and mismatched ack bindings fail closed", () => {
	const record = terminal();
	const pending = pendingWakeMarker(record, 4);
	const wrongRun = delivery(1, [{ runId: "bg-other", sequence: 4 }]);
	const wrongSequence = delivery(2, [{ runId: record.runId, sequence: 3 }]);
	const wrongSession = { ...delivery(3, [{ runId: record.runId, sequence: 4 }]), sessionId: "other-session" };
	const valid = delivery(4, [{ runId: record.runId, sequence: 4 }]);
	const wrongAckRun = { ...acknowledgedWakeMarker(valid), items: [{ runId: "bg-other", sequence: 4 }] };
	const wrongAckSequence = { ...acknowledgedWakeMarker(valid), items: [{ runId: record.runId, sequence: 3 }] };
	const wrongAckSession = { ...acknowledgedWakeMarker(valid), sessionId: "other-session" };
	const wrongAckAttempt = { ...acknowledgedWakeMarker(valid), attempt: 5 };
	const retry = delivery(6, [{ runId: record.runId, sequence: 4 }]);
	const state = reconstructWakeOutbox([
		markerEntry(pending),
		markerEntry(wrongRun),
		markerEntry(wrongSequence),
		markerEntry(wrongSession),
		markerEntry(valid),
		markerEntry(wrongAckRun),
		markerEntry(wrongAckSequence),
		markerEntry(wrongAckSession),
		markerEntry(wrongAckAttempt),
		markerEntry(retry),
		markerEntry(acknowledgedWakeMarker(retry)),
	], sessionId);
	assert.equal(state.pending.size, 0);
	assert.equal(state.acknowledged.has(record.runId), true);
	assert.ok(state.invalidMarkerCount >= 7);
	assert.equal(state.maxAttempt, 6);
});

test("legacy and session-mismatched wake markers are strictly rejected", () => {
	assert.equal(parseBackgroundWakeMarker({ version: 1, runId: "bg-one", state: "pending" }, sessionId), undefined);
	const marker = pendingWakeMarker(terminal(), 1);
	assert.equal(parseBackgroundWakeMarker({ ...marker, sessionId: "other-session" }, sessionId), undefined);
});
