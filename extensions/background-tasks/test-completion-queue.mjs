import assert from "node:assert/strict";
import test from "node:test";
import { createCompletionQueue } from "./completion-queue.ts";

class FakeScheduler {
	tasks = new Map();
	next = 1;
	setTimeout(callback) {
		const id = this.next++;
		this.tasks.set(id, callback);
		return id;
	}
	clearTimeout(id) { this.tasks.delete(id); }
	runAll() {
		const callbacks = [...this.tasks.values()];
		this.tasks.clear();
		for (const callback of callbacks) callback();
	}
}

test("idle completions coalesce into one wake and duplicate ids are ignored", () => {
	const scheduler = new FakeScheduler();
	const flushes = [];
	const queue = createCompletionQueue({ scheduler, onFlush: (items) => flushes.push(items.map((item) => item.id)) });
	assert.equal(queue.enqueue({ id: "one" }), true);
	assert.equal(queue.enqueue({ id: "two" }), true);
	assert.equal(queue.enqueue({ id: "one" }), false);
	scheduler.runAll();
	assert.deepEqual(flushes, [["one", "two"]]);
	assert.equal(queue.deliveredCount, 2);
});

test("completion while parent is busy waits for the owner-reported settled boundary", () => {
	const scheduler = new FakeScheduler();
	const flushes = [];
	const queue = createCompletionQueue({ scheduler, onFlush: (items) => flushes.push(items) });
	queue.setParentActive(true);
	queue.enqueue({ id: "one" });
	scheduler.runAll();
	assert.equal(flushes.length, 0);
	assert.equal(queue.pendingCount, 1);
	queue.setParentActive(false);
	scheduler.runAll();
	assert.equal(flushes.length, 1);
	assert.equal(flushes[0][0].id, "one");
});

test("becoming busy cancels an idle timer without dropping completion", () => {
	const scheduler = new FakeScheduler();
	let count = 0;
	const queue = createCompletionQueue({ scheduler, onFlush: () => { count += 1; } });
	queue.enqueue({ id: "one" });
	queue.setParentActive(true);
	scheduler.runAll();
	assert.equal(count, 0);
	queue.setParentActive(false);
	scheduler.runAll();
	assert.equal(count, 1);
});

test("an unacknowledged delivered item can be released and retried after backoff", () => {
	const scheduler = new FakeScheduler();
	const flushes = [];
	const item = { id: "one" };
	const queue = createCompletionQueue({ scheduler, onFlush: (items) => flushes.push(items.map((entry) => entry.id)) });
	queue.enqueue(item);
	scheduler.runAll();
	assert.deepEqual(flushes, [["one"]]);
	queue.release([item]);
	assert.equal(queue.pendingCount, 1);
	assert.equal(queue.deliveredCount, 0);
	queue.rearm();
	scheduler.runAll();
	assert.deepEqual(flushes, [["one"], ["one"]]);
});

test("clear drops old-branch dedupe state and allows the same id on a new branch", () => {
	const scheduler = new FakeScheduler();
	const flushes = [];
	const queue = createCompletionQueue({ scheduler, onFlush: (items) => flushes.push(items.map((item) => item.id)) });
	queue.enqueue({ id: "one" });
	scheduler.runAll();
	queue.clear();
	assert.equal(queue.enqueue({ id: "one" }), true);
	scheduler.runAll();
	assert.deepEqual(flushes, [["one"], ["one"]]);
});

test("stop clears pending wakeups", () => {
	const scheduler = new FakeScheduler();
	let count = 0;
	const queue = createCompletionQueue({ scheduler, onFlush: () => { count += 1; } });
	queue.enqueue({ id: "one" });
	queue.stop();
	scheduler.runAll();
	assert.equal(count, 0);
	assert.equal(queue.enqueue({ id: "two" }), false);
});
