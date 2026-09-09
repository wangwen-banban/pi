import assert from "node:assert/strict";
import test from "node:test";
import { boundedConversation, canSkipRoutingAdvisor, collectParentMessages, serializeMessages, textFromContent } from "./context.ts";

const user = (text) => ({ role: "user", text });
const assistant = (text) => ({ role: "assistant", text });
const message = (role, content) => ({ type: "message", message: { role, content } });

test("inheritance reads only the effective context, never the raw branch", () => {
	const view = {
		buildContextEntries: () => [{ type: "compaction", summary: "current summary" }, message("user", "latest request")],
		getBranch() { throw new Error("raw history must not be read"); },
		getEntries() { throw new Error("other branches must not be read"); },
	};
	assert.deepEqual(collectParentMessages(view), [assistant("[Compaction summary]\ncurrent summary"), user("latest request")]);
});

test("active branch summaries are retained as reference text", () => {
	assert.deepEqual(collectParentMessages({ buildContextEntries: () => [{ type: "branch_summary", summary: "selected branch" }] }),
		[assistant("[Branch summary]\nselected branch")]);
});

test("state markers, tool results, images and thinking do not become inherited instructions", () => {
	const entries = [null, undefined, 7, [], {}, { type: "message", message: null },
		{ type: "custom", data: "private runtime data" },
		{ type: "custom_message", content: "not part of this text projection" },
		message("toolResult", "raw tool output"), message("assistant", [{ type: "thinking", thinking: "private" }]),
		message("user", [{ type: "image", data: "image" }, { type: "text", text: "visible" }])];
	assert.deepEqual(collectParentMessages({ buildContextEntries: () => entries }), [user("visible")]);
});

test("failed effective-context reads stop inheritance instead of falling back to stale history", () => {
	assert.throws(() => collectParentMessages({ buildContextEntries() { throw new Error("context unavailable"); } }), /context unavailable/);
	assert.throws(() => collectParentMessages({ getBranch: () => [message("user", "stale")] }), /buildContextEntries/);
});

test("text projection preserves existing text-only semantics", () => {
	assert.equal(textFromContent("plain"), "plain");
	assert.equal(textFromContent([null, { type: "text", text: "one" }, { type: "image" }, { type: "text", text: "two" }]), "one\ntwo");
	assert.equal(textFromContent(null), "");
	assert.equal(serializeMessages([user("one"), assistant("two")]), "User: one\n\nAssistant: two");
});

test("short conversations pass through unchanged without padding", () => {
	assert.equal(boundedConversation([user("latest")], 100), "User: latest");
	assert.equal(boundedConversation([], 100), "");
});

test("bounded input uses the recent tail, not the oldest conversation prefix", () => {
	const text = boundedConversation([user("OLD".repeat(2000)), assistant("old answer"), user("NEW constraint"), assistant("NEW evidence")], 180);
	assert.ok(text.length <= 180);
	assert.match(text, /NEW constraint/);
	assert.ok(text.endsWith("NEW evidence"));
	assert.ok(text.startsWith("[Earlier content omitted]"));
});

test("a large assistant reply cannot evict the latest short user constraint", () => {
	const text = boundedConversation([user("Do not change the API"), assistant("x".repeat(5000) + "LATEST-EVIDENCE")], 200);
	assert.ok(text.length <= 200);
	assert.match(text, /User: Do not change the API/);
	assert.ok(text.endsWith("LATEST-EVIDENCE"));
	assert.equal(text.split("Do not change the API").length - 1, 1);
});

test("large user messages are bounded too; the budget is not expanded", () => {
	for (const messages of [[user("u".repeat(5000))], [user("u".repeat(5000)), assistant("e".repeat(5000))]]) {
		const text = boundedConversation(messages, 200);
		assert.ok(text.length <= 200);
		assert.match(text, /User: /);
	}
});

test("assistant-only context uses a bounded tail", () => {
	const text = boundedConversation([assistant("old".repeat(500) + "NEW")], 100);
	assert.ok(text.length <= 100);
	assert.ok(text.endsWith("NEW"));
});

test("invalid and small budgets are safe and UTF-16 pairs are not split", () => {
	for (const limit of [0, -1, Number.NaN, Infinity]) assert.equal(boundedConversation([user("abc")], limit), "");
	for (const limit of [1, 2, 3, 41, 100, 101, 150.8]) {
		const text = boundedConversation([user("🙂".repeat(100)), assistant("🙂".repeat(100))], limit);
		assert.ok(text.length <= Math.floor(limit));
		assert.ok(text.isWellFormed());
	}
});

test("budgeting never mutates the parent messages", () => {
	const messages = Object.freeze([Object.freeze(user("important")), Object.freeze(assistant("x".repeat(4000)))]);
	boundedConversation(messages, 200);
	assert.equal(messages[1].text.length, 4000);
});

test("the original complexity/context/permission explicit fast path is preserved", () => {
	for (const complexity of ["simple", "medium", "complex", "critical"])
		for (const contextMode of ["isolated", "selected", "full"])
			for (const permission of ["read-only", "workspace-write"])
				assert.equal(canSkipRoutingAdvisor({ complexity, contextMode, permission }), true);
});

test("fixed model/effort/context/permission skips redundant advisory classification", () => {
	for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		assert.equal(canSkipRoutingAdvisor({ model: "fixture/model", effort, complexity: "auto", contextMode: "selected", permission: "read-only" }), true);
	}
});

test("summary requests still require the advisor, even with all other fields fixed", () => {
	assert.equal(canSkipRoutingAdvisor({ model: "fixture/model", effort: "low", complexity: "simple", contextMode: "summary", permission: "read-only" }), false);
});

test("model and effort alone never infer context or write permission", () => {
	const base = { model: "fixture/model", effort: "low", contextMode: "selected", permission: "read-only" };
	for (const field of ["model", "effort", "contextMode", "permission"]) {
		assert.equal(canSkipRoutingAdvisor({ ...base, [field]: "auto" }), false);
		assert.equal(canSkipRoutingAdvisor({ ...base, [field]: undefined }), false);
	}
});

test("unknown routing enums cannot activate the explicit fast path", () => {
	for (const params of [
		{ model: "", effort: "low", contextMode: "selected", permission: "read-only" },
		{ model: 123, effort: "low", contextMode: "selected", permission: "read-only" },
		{ model: "fixture/model", effort: "invalid", contextMode: "selected", permission: "read-only" },
		{ complexity: "simple", contextMode: "invalid", permission: "read-only" },
		{ complexity: "simple", contextMode: "selected", permission: "invalid" },
	]) assert.equal(canSkipRoutingAdvisor(params), false);
});
