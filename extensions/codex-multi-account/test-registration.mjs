import assert from "node:assert/strict";
import extension, { __testing, bridgeSecondaryCodexStream } from "./index.ts";

const { createAssistantMessageEventStream } = await import(
  "/Users/wenwang/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js"
);

let registration;
await extension({
  registerProvider(id, config) {
    registration = { id, config };
  },
});

assert.ok(registration, "provider should be registered");
assert.equal(registration.id, "openai-codex-second");
assert.equal(registration.config.api, "openai-codex-responses");
assert.equal(registration.config.baseUrl, "https://chatgpt.com/backend-api");
assert.equal(registration.config.oauth.name, "OpenAI Codex (Second Account)");
assert.equal(registration.config.oauth.getApiKey({ access: "account-b-token" }), "account-b-token");

const modelIds = registration.config.models.map((model) => model.id);
assert.ok(modelIds.includes("gpt-5.6-sol"), "should clone the current built-in Codex models");
assert.ok(modelIds.includes("gpt-5.4"), "should clone all built-in Codex models");
assert.ok(registration.config.models.every((model) => model.provider === undefined));

assert.equal(registration.config.streamSimple, undefined, "provider-routing owns the shared transport override");

const assistant = {
  role: "assistant",
  provider: "openai-codex-second",
  api: "openai-codex-responses",
  model: "gpt-5.6-sol",
  content: [],
  usage: {},
  stopReason: "stop",
  timestamp: 1,
};
const canonical = __testing.canonicalizeSecondaryCodexMessage(assistant);
assert.equal(canonical.provider, "openai-codex");
assert.equal(assistant.provider, "openai-codex-second", "mapping must not mutate session history");

const user = { role: "user", content: "hello", timestamp: 1 };
assert.equal(__testing.canonicalizeSecondaryCodexMessage(user), user, "non-assistant messages stay untouched");

const done = __testing.mapEventProvider({ type: "done", reason: "stop", message: { ...assistant, provider: "openai-codex" } }, "openai-codex-second");
assert.equal(done.message.provider, "openai-codex-second");
const delta = __testing.mapEventProvider({ type: "text_delta", contentIndex: 0, delta: "x", partial: { ...assistant, provider: "openai-codex" } }, "openai-codex-second");
assert.equal(delta.partial.provider, "openai-codex-second");

const source = createAssistantMessageEventStream();
const bridged = bridgeSecondaryCodexStream(
  source,
  { ...registration.config.models[0], provider: "openai-codex-second", baseUrl: registration.config.baseUrl },
  createAssistantMessageEventStream,
);
source.push({ type: "start", partial: { ...assistant, provider: "openai-codex" } });
source.push({ type: "done", reason: "stop", message: { ...assistant, provider: "openai-codex" } });
const bridgedEvents = [];
for await (const event of bridged) bridgedEvents.push(event);
assert.deepEqual(bridgedEvents.map((event) => event.type), ["start", "done"]);
assert.ok(bridgedEvents.every((event) => (event.partial ?? event.message).provider === "openai-codex-second"));
assert.equal((await bridged.result()).provider, "openai-codex-second");

assert.deepEqual(
  __testing.legacyCredentials({ type: "oauth", access: "a", refresh: "r", expires: 42, accountId: "b" }),
  { access: "a", refresh: "r", expires: 42, accountId: "b" },
);

console.log(`✓ registered ${registration.id} with ${modelIds.length} models`);
console.log("✓ OAuth key, context mapping, and stream mapping verified");
