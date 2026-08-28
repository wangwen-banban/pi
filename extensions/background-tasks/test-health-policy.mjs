import assert from "node:assert/strict";
import test from "node:test";
import {
	createBackgroundHealthMonitor,
	parseBackgroundHealthReport,
} from "./health-policy.ts";

const policy = (overrides = {}) => ({
	startupGraceMs: 100,
	heartbeatTimeoutMs: 50,
	unavailableTimeoutMs: 120,
	...overrides,
});
const report = (health, progress) => ({ version: 1, health, ...(progress === undefined ? {} : { progress }) });

test("missing first report and lost heartbeat fail at their exact local deadlines", () => {
	let monitor = createBackgroundHealthMonitor(policy(), 1_000);
	assert.equal(monitor.evaluate(1_099).failure, undefined);
	assert.equal(monitor.evaluate(1_100).failure.code, "startup_timeout");

	monitor = createBackgroundHealthMonitor(policy(), 2_000);
	monitor.report(report("healthy", "phase-1"), 2_010);
	assert.equal(monitor.evaluate(2_059).failure, undefined);
	assert.equal(monitor.evaluate(2_060).failure.code, "heartbeat_timeout");
});

test("transient unavailable health recovers without erasing prior progress age", () => {
	const monitor = createBackgroundHealthMonitor(policy({ staleProgressTimeoutMs: 200 }), 0);
	monitor.report(report("healthy", "one"), 10);
	monitor.report(report("unavailable"), 40);
	monitor.report(report("unavailable"), 70);
	assert.equal(monitor.evaluate(79).failure, undefined);
	const recovered = monitor.report(report("healthy", "one"), 80);
	assert.equal(recovered.status, "healthy");
	assert.equal(recovered.unavailableSince, undefined);
	assert.equal(recovered.lastProgressAt, 10, "same-token recovery must not reset stale progress");
	monitor.report(report("healthy", "one"), 120);
	assert.equal(monitor.evaluate(159).failure, undefined);
	assert.equal(monitor.report(report("healthy", "two"), 159).lastProgressAt, 159);
});

test("continuous unavailable reports cannot keep an alive monitor in progress forever", () => {
	const monitor = createBackgroundHealthMonitor(policy(), 0);
	monitor.report(report("unavailable"), 10);
	monitor.report(report("unavailable"), 50);
	monitor.report(report("unavailable"), 90);
	monitor.report(report("unavailable"), 129);
	assert.equal(monitor.evaluate(129).failure, undefined);
	assert.equal(monitor.evaluate(130).failure.code, "unavailable_timeout");
});

test("alternating brief outages cannot evade the stale-progress bound", () => {
	const monitor = createBackgroundHealthMonitor(policy({ staleProgressTimeoutMs: 100 }), 0);
	monitor.report(report("healthy", "same"), 10);
	monitor.report(report("unavailable"), 40);
	monitor.report(report("healthy", "same"), 70);
	monitor.report(report("unavailable"), 90);
	monitor.report(report("healthy", "same"), 109);
	assert.equal(monitor.evaluate(109).failure, undefined);
	assert.equal(monitor.evaluate(110).failure.code, "stale_progress");
});

test("healthy heartbeats with an unchanged progress token fail as stale", () => {
	const monitor = createBackgroundHealthMonitor(policy({ staleProgressTimeoutMs: 100 }), 0);
	monitor.report(report("healthy", "same"), 10);
	monitor.report(report("healthy", "same"), 50);
	monitor.report(report("healthy", "same"), 90);
	assert.equal(monitor.evaluate(109).failure, undefined);
	assert.equal(monitor.evaluate(110).failure.code, "stale_progress");
});

test("progress tokens are opaque, bounded, and machine-readable rather than log text", () => {
	assert.deepEqual(parseBackgroundHealthReport('{"version":1,"health":"healthy","progress":42}'), report("healthy", 42));
	assert.throws(() => parseBackgroundHealthReport("remote unavailable"), /not valid JSON/);
	assert.throws(() => parseBackgroundHealthReport('{"version":1,"health":"unknown"}'), /healthy.*unavailable/);
	assert.throws(() => parseBackgroundHealthReport('{"version":1,"health":"healthy","progress":null}'), /finite number or string/);
});
