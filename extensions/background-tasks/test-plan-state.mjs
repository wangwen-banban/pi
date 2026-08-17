import assert from "node:assert/strict";
import test from "node:test";
import {
	COMPLETED_TASK_HOLD_MS,
	TASK_PLAN_MARKER_TYPE,
	attachRunToTask,
	emptyTaskPlan,
	finishTaskRun,
	nextPendingTask,
	reconcileTaskPlan,
	reconstructTaskPlan,
	taskPlanText,
	taskVisibleInCompactUi,
	visibleTaskPlanItems,
} from "./plan-state.ts";

const tasks = (...items) => items;
const task = (id, title, status = "pending") => ({ id, title, status });

test("dynamic plan revisions add, reorder, cancel omitted pending, and retain history", () => {
	const first = reconcileTaskPlan(emptyTaskPlan(1), 0, tasks(
		task("benchmark", "Run benchmark", "in_progress"),
		task("analyze", "Analyze results"),
		task("report", "Write report"),
	), "initial", 10);
	assert.equal(first.revision, 1);

	const done = {
		...first,
		tasks: first.tasks.map((item) => item.id === "benchmark" ? { ...item, status: "completed", result: "ok" } : item),
	};
	const revised = reconcileTaskPlan(done, 1, tasks(
		task("report", "Publish report first"),
		task("extra", "Check regression"),
	), "user reprioritized", 20);
	assert.deepEqual(revised.tasks.map((item) => [item.id, item.status]), [
		["report", "pending"],
		["extra", "pending"],
		["benchmark", "completed"],
		["analyze", "cancelled"],
	]);
	assert.equal(revised.reason, "user reprioritized");
	assert.equal(revised.revision, 2);
});

test("plan enforces one in-progress task while allowing pending work to change", () => {
	assert.throws(
		() => reconcileTaskPlan(emptyTaskPlan(), 0, [
			task("one", "One", "in_progress"),
			task("two", "Two", "in_progress"),
		]),
		/at most one in_progress/,
	);
});

test("stale revision is rejected instead of overwriting a completion", () => {
	const current = reconcileTaskPlan(emptyTaskPlan(), 0, [task("one", "One")]);
	assert.throws(
		() => reconcileTaskPlan(current, 0, [task("one", "Changed")]),
		/revision conflict: expected 1, received 0/,
	);
});

test("active managed task cannot be removed or assigned a forged terminal state", () => {
	let plan = reconcileTaskPlan(emptyTaskPlan(), 0, [task("run", "Long run"), task("next", "Next")]);
	plan = attachRunToTask(plan, "run", "bg-run-1", "Long run", 100);
	assert.throws(() => reconcileTaskPlan(plan, plan.revision, [task("next", "Next")]), /active background run and cannot be removed/);
	assert.throws(
		() => reconcileTaskPlan(plan, plan.revision, [task("run", "Long run", "completed"), task("next", "Next")]),
		/stop it before changing status/,
	);
});

test("user may update and reorder pending work while a run remains active", () => {
	let plan = reconcileTaskPlan(emptyTaskPlan(), 0, [
		task("run", "Long run"),
		task("analyze", "Analyze"),
		task("report", "Report"),
	]);
	plan = attachRunToTask(plan, "run", "bg-run-2", "Long run", 100);
	const revised = reconcileTaskPlan(plan, plan.revision, [
		task("run", "Long run", "in_progress"),
		task("report", "Report first"),
		task("analyze", "Analyze second"),
	], "new prompt changed priority", 200);
	assert.equal(revised.tasks[0].runId, "bg-run-2");
	assert.deepEqual(revised.tasks.map((item) => item.id), ["run", "report", "analyze"]);

	const completed = finishTaskRun(revised, "run", "bg-run-2", "completed", "exit 0", 300);
	assert.equal(completed.revision, revised.revision + 1);
	assert.equal(nextPendingTask(completed)?.id, "report", "completion must use the latest reordered plan");
});

test("failed task can be explicitly reset before retry and gets a fresh run", () => {
	let plan = reconcileTaskPlan(emptyTaskPlan(), 0, [task("run", "Run")]);
	plan = attachRunToTask(plan, "run", "bg-old", "Run");
	plan = finishTaskRun(plan, "run", "bg-old", "failed", "exit 2");
	plan = reconcileTaskPlan(plan, plan.revision, [task("run", "Retry run", "pending")], "retry", 500);
	assert.equal(plan.tasks[0].runId, undefined);
	assert.equal(plan.tasks[0].result, undefined);
	plan = attachRunToTask(plan, "run", "bg-new", "Retry run", 600);
	assert.equal(plan.tasks[0].runId, "bg-new");
});

test("dynamic reconciliation never exceeds the persisted 50-task contract", () => {
	const history = Array.from({ length: 50 }, (_, index) => task(`old-${index}`, `Old ${index}`, "completed"));
	let plan = reconcileTaskPlan(emptyTaskPlan(), 0, history);
	const desired = Array.from({ length: 50 }, (_, index) => task(`new-${index}`, `New ${index}`));
	plan = reconcileTaskPlan(plan, plan.revision, desired, "replace full board");
	assert.equal(plan.tasks.length, 50);
	assert.equal(plan.tasks[0].id, "new-0");
	assert.equal(plan.tasks.some((item) => item.id.startsWith("old-")), false);
	assert.throws(
		() => attachRunToTask(plan, "extra", "bg-extra", "Extra"),
		/already contains 50 tasks/,
	);
});

test("branch reconstruction takes the newest valid marker", () => {
	const first = reconcileTaskPlan(emptyTaskPlan(1), 0, [task("old", "Old")], "old", 2);
	const second = reconcileTaskPlan(first, first.revision, [task("new", "New")], "new", 3);
	const reconstructed = reconstructTaskPlan([
		{ type: "custom", customType: TASK_PLAN_MARKER_TYPE, data: first },
		{ type: "message", message: { role: "user" } },
		{ type: "custom", customType: TASK_PLAN_MARKER_TYPE, data: second },
	]);
	assert.equal(reconstructed.revision, 2);
	assert.equal(reconstructed.tasks[0].id, "new");
});

test("compact display keeps completed tasks briefly, then reveals later pending work", () => {
	const now = 100_000;
	const plan = {
		...emptyTaskPlan(now),
		revision: 1,
		tasks: [
			{ id: "recent", title: "Recent", status: "completed", updatedAt: now - COMPLETED_TASK_HOLD_MS + 1 },
			{ id: "expired", title: "Expired", status: "completed", updatedAt: now - COMPLETED_TASK_HOLD_MS },
			{ id: "failed", title: "Failed", status: "failed", updatedAt: 1 },
			{ id: "blocked", title: "Blocked", status: "blocked", updatedAt: 1 },
			{ id: "pending", title: "Pending", status: "pending", updatedAt: 1 },
		],
	};
	assert.equal(taskVisibleInCompactUi(plan.tasks[0], now), true, "59,999ms is still visible");
	assert.equal(taskVisibleInCompactUi(plan.tasks[1], now), false, "60,000ms is hidden");
	assert.equal(taskVisibleInCompactUi({ ...plan.tasks[0], updatedAt: now + 1_000 }, now), true, "clock rollback cannot hide early");
	assert.deepEqual(visibleTaskPlanItems(plan, now).map((item) => item.id), ["recent", "failed", "blocked", "pending"]);
	assert.equal(plan.tasks.length, 5, "display filtering must not mutate persisted history");
});

test("task plan text remains compact and status-visible", () => {
	const plan = reconcileTaskPlan(emptyTaskPlan(), 0, [
		task("one", "First", "completed"),
		task("two", "Second", "pending"),
	]);
	assert.match(taskPlanText(plan), /revision 1/);
	assert.match(taskPlanText(plan), /✓ one: First \[completed\]/);
	assert.match(taskPlanText(plan), /○ two: Second \[pending\]/);
});
