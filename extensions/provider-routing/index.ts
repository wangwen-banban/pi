import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  bridgeSecondaryCodexStream,
  canonicalizeSecondaryCodexMessage,
} from "../codex-multi-account/index.ts";
import {
  createRoutedHttpTransport,
  type RoutedHttpTransportOptions,
} from "./transport.ts";


const PI_ROOT = "/Users/wenwang/.nvm/versions/node/v22.22.2/lib/node_modules/@earendil-works/pi-coding-agent";
const PI_AI_COMPAT = `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/compat.js`;
const ROUTING_PATH = join(homedir(), ".pi", "agent", "provider-routing.json");

interface RouteEntry {
  mode: "direct" | "proxy";
  proxyUrl?: string;
  baseUrl?: string;
  modelId?: string;
  requestModelId?: string;
  contextWindow?: number;
  maxTokens?: number;
}

interface RoutingConfig {
  providers: Record<string, RouteEntry>;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function routeFor(provider: string): RouteEntry {
  const route = readJson<RoutingConfig>(ROUTING_PATH).providers?.[provider];
  if (!route) return { mode: "direct" };
  if (route.mode === "proxy" && !route.proxyUrl) {
    throw new Error(`Provider ${provider} is set to proxy but proxyUrl is empty in ${ROUTING_PATH}`);
  }
  return route;
}

function withRouteEnv(base: Record<string, string> | undefined, route: RouteEntry): Record<string, string> {
  const env = { ...(base ?? {}) };
  const proxyKeys = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
  for (const key of proxyKeys) delete env[key];
  if (route.mode === "proxy") {
    env.HTTP_PROXY = route.proxyUrl!;
    env.HTTPS_PROXY = route.proxyUrl!;
  }
  return env;
}

let compatPromise: Promise<any> | undefined;
function compat(): Promise<any> {
  compatPromise ??= import(PI_AI_COMPAT);
  return compatPromise;
}

/** Errors that should trigger a retry (typically happen before content starts streaming) */
const RETRYABLE_PATTERNS = [
  "Model access is denied",
  "aws-marketplace",
  "IAM user or service role is not authorized",
  "ViewSubscriptions",
  "rate limit",
  "overloaded",
  "529",
  "503",
];

/** Errors where the stream delivered content but closed improperly — just heal the stop */
const HEALABLE_PATTERNS = [
  "stream ended without a stop reason",
  "stream ended before message_stop",
];

function matchesAny(msg: string | undefined, patterns: string[]): boolean {
  if (!msg) return false;
  return patterns.some((p) => msg.includes(p));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract error message from alibaba's non-standard SSE error formats:
 *   Format 1: data: {"error":{"message":"..."},"type":"error"}
 *   Format 2: data: {"type":"error","error":{"type":"api_error","message":"..."}}
 */
function extractAlibabaSSEError(text: string): string | null {
  // Try both formats
  const m1 = text.match(/data:\s*\{"error":\{"message":"((?:[^"\\]|\\.)*)"/);
  const m2 = text.match(/data:\s*\{"type":\s*"error",\s*"error":\s*\{[^}]*"message":\s*"((?:[^"\\]|\\.)*)"/);
  const raw = (m1 ?? m2)?.[1];
  if (!raw) return null;
  try { return JSON.parse('"' + raw + '"'); } catch { return raw; }
}

function retryDelay(attempt: number): number {
  // Exponential backoff: 2s, 4s, 8s, 16s, 32s (with jitter)
  const base = Math.min(2_000 * 2 ** attempt, 32_000);
  return base * (0.75 + Math.random() * 0.5);
}

/**
 * Wraps alibaba relay stream calls with:
 * 1. Retry logic (up to maxRetries) for transient errors (IAM, rate-limit, etc.)
 * 2. Stream healing for "ended without stop reason" errors
 *
 * Returns a wrapper stream immediately; retries happen transparently inside.
 */
function streamWithRetry(
  makeStream: () => Promise<AssistantMessageEventStream>,
  createStream: () => AssistantMessageEventStream,
  model: Model<any>,
  maxRetries: number = 5,
): AssistantMessageEventStream {
  const wrapper = createStream();
  const errorMessage = (message: string, httpStatus?: number): AssistantMessage => ({
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    timestamp: Date.now(),
  });
  (async () => {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Buffer events per attempt. Only flush to wrapper once we confirm
      // the attempt has real content. This prevents "working" indicator
      // flickering across retries and garbled event sequences.
      const buffer: any[] = [];
      let hasRealContent = false;
      let flushed = false;

      function flushBuffer() {
        if (flushed) return;
        flushed = true;
        for (const ev of buffer) wrapper.push(ev);
        buffer.length = 0;
      }

      try {
        const inner = await makeStream();
        let shouldRetry = false;

        for await (const event of inner) {
          const errMsg = event.error?.errorMessage ?? event.error?.message ?? "";

          // --- Retryable error (before content flushed) ---
          if (event.type === "error" && !flushed && matchesAny(errMsg, RETRYABLE_PATTERNS)) {
            lastError = event;
            await sleep(retryDelay(attempt));
            shouldRetry = true;
            break;
          }

          // --- Healable stream error ---
          if (event.type === "error" && matchesAny(errMsg, HEALABLE_PATTERNS)) {
            const output = event.error;
            const contentDelivered = hasRealContent && (output?.content ?? []).some(
              (c: any) => (c.type === "text" && c.text?.trim()) || c.type === "toolCall",
            );
            if (contentDelivered) {
              // Content was sent → heal and finish.
              flushBuffer();
              output.stopReason = "end_turn";
              delete output.errorMessage;
              wrapper.push({ type: "done", reason: "end_turn", message: output });
              return;
            }
            // Empty stream → retry.
            lastError = event;
            await sleep(retryDelay(attempt));
            shouldRetry = true;
            break;
          }

          // --- Non-retryable error → surface immediately ---
          if (event.type === "error") {
            flushBuffer();
            wrapper.push(event);
            return;
          }

          // --- Normal event ---
          // Detect real content: text deltas or tool calls.
          if (!hasRealContent && event.type !== "done") {
            const msg = event.partial ?? event.message ?? event.error;
            const content = Array.isArray(msg?.content) ? msg.content : [];
            if (
              (event.type === "text_delta" && typeof event.delta === "string" && event.delta.trim()) ||
              content.some((c: any) =>
                (c.type === "text" && c.text?.trim()) || c.type === "toolCall"
              )
            ) {
              hasRealContent = true;
            }
          }

          // Once we have real content, flush everything (enables streaming UX).
          if (hasRealContent && !flushed) {
            flushBuffer();
          }

          if (flushed) {
            wrapper.push(event);
          } else {
            buffer.push(event);
          }

          if (event.type === "done") {
            if (!flushed) flushBuffer(); // edge: done without content (unusual but valid)
            return;
          }
        }

        if (shouldRetry) continue;
        // Stream completed without done/error and without breaking for retry.
        // This shouldn't happen normally but treat as retryable.
        if (!flushed) {
          lastError = { error: { errorMessage: "Stream ended unexpectedly without events" } };
          await sleep(retryDelay(attempt));
          continue;
        }
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        if (attempt < maxRetries && matchesAny(errMsg, RETRYABLE_PATTERNS)) {
          lastError = err;
          await sleep(retryDelay(attempt));
          continue;
        }
        wrapper.push({ type: "error", reason: "error", error: errorMessage(errMsg, err?.status) });
        return;
      }
    }
    // All retries exhausted.
    const exhaust = lastError?.error ?? lastError;
    const exhaustMsg =
      exhaust?.errorMessage ?? exhaust?.message ?? `Retry exhausted after ${maxRetries + 1} attempts`;
    wrapper.push({
      type: "error",
      reason: "error",
      error: errorMessage(`[alibaba-relay] ${exhaustMsg}`),
    });
  })();
  return wrapper;
}

export function registerProviderRouting(
  pi: ExtensionAPI,
  transportOptions: RoutedHttpTransportOptions = {},
) {
  // undici is an optional optimization, not a load-time dependency. The
  // Node-core fallback keeps explicit direct/proxy routes working when pi
  // bundles undici or does not expose it through Node's package resolver.
  const transport = createRoutedHttpTransport(transportOptions);
  const relay = routeFor("claude-relay");
  for (const key of ["baseUrl", "modelId", "requestModelId"] as const) {
    if (!relay[key]) throw new Error(`Missing claude-relay.${key} in ${ROUTING_PATH}`);
  }

  // --- claude-relay-alibaba provider ---
  const alibaba = routeFor("claude-relay-alibaba");
  for (const key of ["baseUrl", "modelId", "requestModelId"] as const) {
    if (!alibaba[key]) throw new Error(`Missing claude-relay-alibaba.${key} in ${ROUTING_PATH}`);
  }

  // Alibaba relay requires Claude Code identity headers
  const alibabaSessionId = crypto.randomUUID();

  pi.registerProvider("claude-relay-alibaba", {
    api: "anthropic-messages",
    baseUrl: alibaba.baseUrl,
    headers: {
      "x-claude-code-session-id": alibabaSessionId,
      "user-agent": "claude-code/1.0",
    },
    models: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (Alibaba Relay)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: alibaba.contextWindow ?? 1_000_000,
        maxTokens: alibaba.maxTokens ?? 64_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsPromptCaching: false,
          sendSessionAffinityHeaders: false,
          forceAdaptiveThinking: true,
        },
      },
    ],
    streamSimple: async (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ): Promise<AssistantMessageEventStream> => {
      const provider = (await compat()).getApiProvider("anthropic-messages");
      const env = withRouteEnv(options?.env, alibaba);
      // Filter out web_search tool — alibaba idealab rejects it (confuses with Anthropic built-in server tool)
      const filteredContext: Context = {
        ...context,
        tools: context.tools?.filter((t: any) => t.name !== "web_search"),
      };
      // Inject identity headers + skip TLS verification for internal endpoint.
      // Also detect alibaba's non-standard SSE error format (HTTP 200 + error JSON)
      // and convert it to a proper thrown error so it surfaces to the user.
      const directFetch: typeof fetch = async (input, init) => {
        const headers = new Headers((init as any)?.headers);
        headers.set("x-claude-code-session-id", alibabaSessionId);
        headers.set("user-agent", "claude-code/1.0");

        // Fix thinking format: alibaba only supports adaptive, not "enabled".
        // This is a defensive fix in case pi-ai sends the old format.
        if ((init as any)?.body && typeof (init as any).body === "string") {
          try {
            const reqBody = JSON.parse((init as any).body);
            if (reqBody.thinking?.type === "enabled") {
              const budget = reqBody.thinking.budget_tokens ?? reqBody.max_tokens ?? 8000;
              const effort = budget >= 32000 ? "max" : budget >= 16000 ? "xhigh" : budget >= 8000 ? "high" : budget >= 4000 ? "medium" : "low";
              reqBody.thinking = { type: "adaptive" };
              reqBody.output_config = { effort };
              (init as any) = { ...(init as any), body: JSON.stringify(reqBody) };
            }
          } catch { /* non-JSON body, pass through */ }
        }

        // 90s timeout: if alibaba hangs without responding, abort.
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90_000);
        let resp: any;
        try {
          resp = await transport.fetch(input as any, {
            ...(init as any),
            headers,
            signal: controller.signal,
          }, { rejectUnauthorized: false });
        } catch (e: any) {
          clearTimeout(timeout);
          if (e?.name === "AbortError") throw new Error("[alibaba] 请求超时 (90s)");
          throw e;
        }
        clearTimeout(timeout);
        // Alibaba sometimes returns HTTP 200 with SSE body containing only:
        //   data: {"error":{"message":"...","type":"..."},"type":"error"}
        //   data: [DONE]
        // The Anthropic SDK can't parse this → "stream ended without a stop
        // reason" → user sees nothing. Peek the first chunk to detect this.
        //
        // NOTE: We intentionally avoid body.tee() which is unreliable with
        // undici's ReadableStream on large streaming responses. Instead we
        // read the first chunk, check it, and manually reconstruct the stream.
        if (resp.body) {
          const reader = resp.body.getReader();
          const { value: firstChunk, done } = await reader.read();
          if (done || !firstChunk) {
            reader.releaseLock();
            return resp as any;
          }
          const peek = new TextDecoder().decode(firstChunk).slice(0, 512);
          const firstErr = extractAlibabaSSEError(peek);
          if (firstErr) {
            reader.releaseLock();
            throw new Error(`[alibaba] ${firstErr}`);
          }
          // Reassemble: put the peeked chunk back in front of the rest.
          // Also monitor ALL subsequent chunks for alibaba's mid-stream error
          // format (error can appear after initial message_start + thinking blocks).
          const reconstructed = new ReadableStream({
            start(controller) {
              controller.enqueue(firstChunk);
            },
            async pull(controller) {
              const { value, done: d } = await reader.read();
              if (d) { controller.close(); return; }
              // Check every chunk for alibaba inline errors
              const text = new TextDecoder().decode(value);
              const midErr = extractAlibabaSSEError(text);
              if (midErr) {
                // Signal error on the stream. The downstream Anthropic SDK / pi-ai
                // SSE parser will catch this as an iteration error and surface it.
                controller.error(new Error(`[alibaba] ${midErr}`));
                reader.releaseLock();
                return;
              }
              controller.enqueue(value);
            },
            cancel() { reader.releaseLock(); },
          });
          return new Response(reconstructed, {
            status: resp.status,
            statusText: resp.statusText,
            headers: resp.headers,
          }) as any;
        }
        return resp as any;
      };
      const { createAssistantMessageEventStream } = await import(
        `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`
      );
      return streamWithRetry(
        () => provider.streamSimple(model, filteredContext, { ...options, env, fetch: directFetch }),
        createAssistantMessageEventStream,
        model,
        5, // max 5 retries
      );
    },
  });

  // --- big-data-claude provider ---
  const bigData = routeFor("big-data-claude");
  for (const key of ["baseUrl", "modelId", "requestModelId"] as const) {
    if (!bigData[key]) throw new Error(`Missing big-data-claude.${key} in ${ROUTING_PATH}`);
  }
  const bigDataSessionId = crypto.randomUUID();

  pi.registerProvider("big-data-claude", {
    api: "anthropic-messages",
    baseUrl: bigData.baseUrl,
    headers: {
      "x-claude-code-session-id": bigDataSessionId,
      "user-agent": "claude-code/1.0",
    },
    models: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (Big Data)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: bigData.contextWindow ?? 1_000_000,
        maxTokens: bigData.maxTokens ?? 64_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsPromptCaching: false,
          sendSessionAffinityHeaders: false,
          forceAdaptiveThinking: true,
        },
      },
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (Big Data)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: bigData.contextWindow ?? 1_000_000,
        maxTokens: bigData.maxTokens ?? 64_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        thinkingLevelMap: {
          minimal: "low",
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
          max: "max",
        },
        compat: {
          supportsPromptCaching: false,
          sendSessionAffinityHeaders: false,
          forceAdaptiveThinking: true,
        },
      },
    ],
    streamSimple: async (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ): Promise<AssistantMessageEventStream> => {
      const provider = (await compat()).getApiProvider("anthropic-messages");
      const env = withRouteEnv(options?.env, bigData);
      const filteredContext: Context = {
        ...context,
        tools: context.tools?.filter((t: any) => t.name !== "web_search"),
      };
      const directFetch: typeof fetch = async (input, init) => {
        const headers = new Headers((init as any)?.headers);
        headers.set("x-claude-code-session-id", bigDataSessionId);
        headers.set("user-agent", "claude-code/1.0");

        // Fix thinking format
        if ((init as any)?.body && typeof (init as any).body === "string") {
          try {
            const reqBody = JSON.parse((init as any).body);
            if (reqBody.thinking?.type === "enabled") {
              const budget = reqBody.thinking.budget_tokens ?? reqBody.max_tokens ?? 8000;
              const effort = budget >= 32000 ? "max" : budget >= 16000 ? "xhigh" : budget >= 8000 ? "high" : budget >= 4000 ? "medium" : "low";
              reqBody.thinking = { type: "adaptive" };
              reqBody.output_config = { effort };
              (init as any) = { ...(init as any), body: JSON.stringify(reqBody) };
            }
          } catch { /* pass through */ }
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 90_000);
        let resp: any;
        try {
          resp = await transport.fetch(input as any, {
            ...(init as any),
            headers,
            signal: controller.signal,
          }, { rejectUnauthorized: false });
        } catch (e: any) {
          clearTimeout(timeout);
          if (e?.name === "AbortError") throw new Error("[big-data-claude] 请求超时 (90s)");
          throw e;
        }
        clearTimeout(timeout);

        if (resp.body) {
          const reader = resp.body.getReader();
          const { value: firstChunk, done } = await reader.read();
          if (done || !firstChunk) { reader.releaseLock(); return resp as any; }
          const peek = new TextDecoder().decode(firstChunk).slice(0, 512);
          const firstErr = extractAlibabaSSEError(peek);
          if (firstErr) { reader.releaseLock(); throw new Error(`[big-data-claude] ${firstErr}`); }
          const reconstructed = new ReadableStream({
            start(c) { c.enqueue(firstChunk); },
            async pull(c) {
              const { value, done: d } = await reader.read();
              if (d) { c.close(); return; }
              const t = new TextDecoder().decode(value);
              const midErr = extractAlibabaSSEError(t);
              if (midErr) { c.error(new Error(`[big-data-claude] ${midErr}`)); reader.releaseLock(); return; }
              c.enqueue(value);
            },
            cancel() { reader.releaseLock(); },
          });
          return new Response(reconstructed, { status: resp.status, statusText: resp.statusText, headers: resp.headers }) as any;
        }
        return resp as any;
      };
      const { createAssistantMessageEventStream } = await import(
        `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`
      );
      return streamWithRetry(
        () => provider.streamSimple(model, filteredContext, { ...options, env, fetch: directFetch }),
        createAssistantMessageEventStream,
        model,
        5,
      );
    },
  });

  // --- claude-relay provider ---
  pi.registerProvider("claude-relay", {
    api: "anthropic-messages",
    baseUrl: relay.baseUrl,
    models: [
      {
        id: relay.modelId!,
        name: "Claude Opus 4.6 (Relay)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: relay.contextWindow ?? 1_000_000,
        maxTokens: relay.maxTokens ?? 64_000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsPromptCaching: false,
          sendSessionAffinityHeaders: false,
          forceAdaptiveThinking: true,
        },
      },
    ],
    streamSimple: async (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ): Promise<AssistantMessageEventStream> => {
      const provider = (await compat()).getApiProvider("anthropic-messages");
      const env = withRouteEnv(options?.env, relay);
      const requestModel = { ...model, id: relay.requestModelId! };
      const directFetch: typeof fetch = (input, init) =>
        transport.fetch(input as any, init as any) as any;
      return provider.streamSimple(requestModel, context, { ...options, env, fetch: directFetch });
    },
  });

  const streamCodexWithPrimaryRoute = async (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessageEventStream> => {
    const provider = (await compat()).getApiProvider("openai-codex-responses");
    const route = routeFor("openai-codex");
    const env = withRouteEnv(options?.env, route);
    if (route.mode !== "proxy") {
      return provider.streamSimple(model, context, { ...options, env });
    }

    const routedFetch: typeof fetch = (input, init) =>
      transport.fetch(input as any, init as any, { proxyUrl: route.proxyUrl! }) as any;
    // Force HTTP/SSE for deterministic proxy routing. The upstream Codex
    // adapter otherwise prefers WebSocket, whose proxy path is runtime-specific.
    return provider.streamSimple(model, context, {
      ...options,
      env,
      fetch: routedFetch,
      transport: "sse",
    });
  };

  // Override only the transport of the built-in Codex provider. OAuth, model
  // discovery, payload shaping, and response parsing remain provided by pi-ai.
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: streamCodexWithPrimaryRoute,
  });

  // The second OAuth account uses the exact same Codex protocol and network
  // route. Canonicalizing internally preserves Codex-specific reasoning/tool
  // semantics; mapping output back keeps session resume tied to account B.
  pi.registerProvider("openai-codex-second", {
    api: "openai-codex-responses",
    streamSimple: async (model, context, options) => {
      const canonicalModel = { ...model, provider: "openai-codex" } as Model<any>;
      const canonicalContext: Context = {
        ...context,
        messages: context.messages.map(canonicalizeSecondaryCodexMessage),
      };
      const source = await streamCodexWithPrimaryRoute(canonicalModel, canonicalContext, options);
      const { createAssistantMessageEventStream } = await import(
        `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`
      );
      return bridgeSecondaryCodexStream(source, model, createAssistantMessageEventStream);
    },
  });

  // Codex defaults to xhigh whenever either account is selected.
  pi.on("model_select", async (event) => {
    if (
      (event.model.provider === "openai-codex" || event.model.provider === "openai-codex-second") &&
      pi.getThinkingLevel() !== "xhigh"
    ) {
      pi.setThinkingLevel("xhigh");
    }
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([transport.close()]);
  });

  pi.registerCommand("provider-routing", {
    description: "Show the editable provider routing configuration",
    handler: async (_args, ctx) => {
      const config = readJson<RoutingConfig>(ROUTING_PATH);
      const lines = Object.entries(config.providers).map(
        ([provider, route]) => `${provider}: ${route.mode}${route.proxyUrl ? ` (${route.proxyUrl})` : ""}`,
      );
      ctx.ui.notify(`${ROUTING_PATH}\n${lines.join("\n")}`, "info");
    },
  });

  pi.registerCommand("check-alibaba", {
    description: "测试 alibaba relay 连通性",
    handler: async (_args, ctx) => {
      ctx.ui.notify("⟳ 正在测试 alibaba relay...", "info");
      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("claude-relay-alibaba");
        const headers = new Headers();
        headers.set("Content-Type", "application/json");
        headers.set("anthropic-version", "2023-06-01");
        headers.set("x-api-key", apiKey ?? "");
        headers.set("x-claude-code-session-id", alibabaSessionId);
        headers.set("user-agent", "claude-code/1.0");
        const body = JSON.stringify({
          model: alibaba.requestModelId,
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let resp: Response;
        try {
          resp = await transport.fetch(alibaba.baseUrl + "/v1/messages", {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
          }, { rejectUnauthorized: false });
        } finally {
          clearTimeout(timer);
        }
        const status = resp.status;
        const text = await (resp as any).text();
        if (status === 200 && text.includes("message_start")) {
          ctx.ui.notify(`✅ alibaba relay 正常 (HTTP ${status}, 流式响应圴序)`, "info");
        } else {
          const msg = text.match(/"message":"([^"]{1,120})"/)?.[1] ?? text.slice(0, 200);
          ctx.ui.notify(`❌ alibaba relay 异常: HTTP ${status} — ${msg}`, "error");
        }
      } catch (e: any) {
        ctx.ui.notify(`❌ alibaba relay 连接失败: ${String(e?.message ?? e).slice(0, 200)}`, "error");
      }
    },
  });
}

export default function providerRouting(pi: ExtensionAPI) {
  registerProviderRouting(pi);
}
