import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  getApiProvider,
} from "@earendil-works/pi-ai";
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
import {
  CODEX_FAST_EVENT,
  CODEX_FAST_MARKER_TYPE,
  applyCodexFastServiceTier,
  buildFastModeMarker,
  fastCreditMultiplier,
  fastModeEvent,
  isCodexFastModel,
  reconstructFastMode,
} from "./fast-mode.ts";


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
 * Extract error message from relay's non-standard SSE error formats:
 *   Format 1: data: {"error":{"message":"..."},"type":"error"}
 *   Format 2: data: {"type":"error","error":{"type":"api_error","message":"..."}}
 */
function extractRelaySSEError(text: string): string | null {
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
 * Wraps relay stream calls with:
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
      error: errorMessage(`[claude-custom] ${exhaustMsg}`),
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
  let fastModeEnabled = false;

  const publishFastMode = (ctx: ExtensionContext) => {
    const state = fastModeEvent(fastModeEnabled, ctx.model);
    try {
      pi.events.emit(CODEX_FAST_EVENT, state);
    } catch {
      // The custom statusline is optional; the request tier remains authoritative.
    }
    if (ctx.hasUI) {
      try {
        ctx.ui.setStatus(
          "codex-fast-mode",
          state.active ? ctx.ui.theme.fg("warning", "⚡ FAST") : undefined,
        );
      } catch {
        // RPC/print modes may not expose a status surface.
      }
    }
    return state;
  };

  const appendFastModeMarker = () => {
    try {
      pi.appendEntry(CODEX_FAST_MARKER_TYPE, buildFastModeMarker(fastModeEnabled));
    } catch {
      // A stale session during replacement must not break provider routing.
    }
  };

  const setFastMode = (enabled: boolean, ctx: ExtensionContext) => {
    const changed = fastModeEnabled !== enabled;
    fastModeEnabled = enabled;
    if (changed) appendFastModeMarker();
    return publishFastMode(ctx);
  };

  // --- claude-custom provider (唯一自定义 Claude 通道) ---
  const claudeRoute = routeFor("claude-custom");
  for (const key of ["baseUrl", "modelId", "requestModelId"] as const) {
    if (!claudeRoute[key]) throw new Error(`Missing claude-custom.${key} in ${ROUTING_PATH}`);
  }
  const claudeSessionId = crypto.randomUUID();

  pi.registerProvider("claude-custom", {
    api: "anthropic-messages",
    baseUrl: claudeRoute.baseUrl,
    headers: {
      "x-claude-code-session-id": claudeSessionId,
      "user-agent": "claude-code/1.0",
    },
    models: [
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (Custom)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: claudeRoute.contextWindow ?? 1_000_000,
        maxTokens: claudeRoute.maxTokens ?? 64_000,
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
        name: "Claude Opus 4.8 (Custom)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: claudeRoute.contextWindow ?? 1_000_000,
        maxTokens: claudeRoute.maxTokens ?? 64_000,
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
      const provider = getApiProvider("anthropic-messages");
      const env = withRouteEnv(options?.env, claudeRoute);
      const filteredContext: Context = {
        ...context,
        tools: context.tools?.filter((t: any) => t.name !== "web_search"),
      };
      const directFetch: typeof fetch = async (input, init) => {
        const headers = new Headers((init as any)?.headers);
        headers.set("x-claude-code-session-id", claudeSessionId);
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
          if (e?.name === "AbortError") throw new Error("[claude-custom] 请求超时 (90s)");
          throw e;
        }
        clearTimeout(timeout);

        if (resp.body) {
          const reader = resp.body.getReader();
          const { value: firstChunk, done } = await reader.read();
          if (done || !firstChunk) { reader.releaseLock(); return resp as any; }
          const peek = new TextDecoder().decode(firstChunk).slice(0, 512);
          const firstErr = extractRelaySSEError(peek);
          if (firstErr) { reader.releaseLock(); throw new Error(`[claude-custom] ${firstErr}`); }
          const reconstructed = new ReadableStream({
            start(c) { c.enqueue(firstChunk); },
            async pull(c) {
              const { value, done: d } = await reader.read();
              if (d) { c.close(); return; }
              const t = new TextDecoder().decode(value);
              const midErr = extractRelaySSEError(t);
              if (midErr) { c.error(new Error(`[claude-custom] ${midErr}`)); reader.releaseLock(); return; }
              c.enqueue(value);
            },
            cancel() { reader.releaseLock(); },
          });
          return new Response(reconstructed, { status: resp.status, statusText: resp.statusText, headers: resp.headers }) as any;
        }
        return resp as any;
      };
      return streamWithRetry(
        () => provider.streamSimple(model, filteredContext, { ...options, env, fetch: directFetch }),
        createAssistantMessageEventStream,
        model,
        5,
      );
    },
  });

  // --- claude-cambricon provider (lab New API gateway) ---
  const cambricon = routeFor("claude-cambricon");
  for (const key of ["baseUrl", "modelId", "requestModelId"] as const) {
    if (!cambricon[key]) throw new Error(`Missing claude-cambricon.${key} in ${ROUTING_PATH}`);
  }
  const cambriconSessionId = crypto.randomUUID();

  pi.registerProvider("claude-cambricon", {
    api: "anthropic-messages",
    baseUrl: cambricon.baseUrl,
    headers: {
      "x-claude-code-session-id": cambriconSessionId,
      "user-agent": "claude-code/1.0",
    },
    models: [
      {
        id: cambricon.modelId!,
        name: "K3 (Cambricon New API)",
        api: "anthropic-messages",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: cambricon.contextWindow ?? 1_000_000,
        maxTokens: cambricon.maxTokens ?? 64_000,
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
      const provider = getApiProvider("anthropic-messages");
      const env = withRouteEnv(options?.env, cambricon);
      const requestModel = { ...model, id: cambricon.requestModelId! };
      const filteredContext: Context = {
        ...context,
        tools: context.tools?.filter((t: any) => t.name !== "web_search"),
      };
      const directFetch: typeof fetch = async (input, init) => {
        const headers = new Headers((init as any)?.headers);
        headers.set("x-claude-code-session-id", cambriconSessionId);
        headers.set("user-agent", "claude-code/1.0");

        // Fix thinking format: adaptive instead of "enabled"
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
        try {
          return await transport.fetch(input as any, {
            ...(init as any),
            headers,
            signal: controller.signal,
          }) as any;
        } catch (e: any) {
          if (e?.name === "AbortError") throw new Error("[claude-cambricon] 请求超时 (90s)");
          throw e;
        } finally {
          clearTimeout(timeout);
        }
      };
      return streamWithRetry(
        () => provider.streamSimple(requestModel, filteredContext, { ...options, env, fetch: directFetch }),
        createAssistantMessageEventStream,
        requestModel,
        5,
      );
    },
  });

  // --- cambricon-codex provider (lab New API gateway, OpenAI Responses) ---
  const codexRoute = routeFor("cambricon-codex");
  if (!codexRoute.baseUrl) throw new Error(`Missing cambricon-codex.baseUrl in ${ROUTING_PATH}`);

  const cambriconCodexModel = (id: string, label: string, contextWindow: number) => ({
    id,
    name: label,
    api: "openai-responses" as const,
    reasoning: true,
    input: ["text", "image"] as ("text" | "image")[],
    contextWindow,
    maxTokens: codexRoute.maxTokens ?? 128_000,
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
    },
  });
  const cambriconContext = codexRoute.contextWindow ?? 1_000_000;

  pi.registerProvider("cambricon-codex", {
    api: "openai-responses",
    baseUrl: codexRoute.baseUrl,
    models: [
      cambriconCodexModel("gpt-5.3-codex-spark", "GPT 5.3 Codex Spark (Cambricon)", 128_000),
      cambriconCodexModel("gpt-5.6-luna", "GPT 5.6 Luna (Cambricon)", cambriconContext),
      cambriconCodexModel("gpt-5.6-terra", "GPT 5.6 Terra (Cambricon)", cambriconContext),
      cambriconCodexModel("gpt-5.6-sol", "GPT 5.6 Sol (Cambricon)", cambriconContext),
      cambriconCodexModel("gpt-6-astra", "GPT 6 Astra (Cambricon)", 1_000_000),
    ],
    streamSimple: async (
      model: Model<any>,
      context: Context,
      options?: SimpleStreamOptions,
    ): Promise<AssistantMessageEventStream> => {
      const provider = getApiProvider("openai-responses");
      const env = withRouteEnv(options?.env, codexRoute);
      const requestModel = { ...model, baseUrl: codexRoute.baseUrl };
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 120_000);
      const directFetch: typeof fetch = async (input, init) => {
        try {
          return await transport.fetch(input as any, {
            ...(init as any),
            signal: controller.signal,
          }) as any;
        } catch (e: any) {
          if (e?.name === "AbortError") throw new Error("[cambricon-codex] 请求超时 (120s)");
          throw e;
        } finally {
          clearTimeout(timeout);
        }
      };
      return provider.streamSimple(requestModel, context, { ...options, env, fetch: directFetch });
    },
  });

  const streamCodexWithPrimaryRoute = async (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ): Promise<AssistantMessageEventStream> => {
    const provider = getApiProvider("openai-codex-responses");
    const route = routeFor("openai-codex");
    const effectiveOptions = applyCodexFastServiceTier(options, model, fastModeEnabled) as SimpleStreamOptions & { serviceTier?: string };
    const env = withRouteEnv(effectiveOptions?.env, route);
    if (route.mode !== "proxy") {
      return provider.streamSimple(model, context, { ...effectiveOptions, env });
    }

    const routedFetch: typeof fetch = (input, init) =>
      transport.fetch(input as any, init as any, { proxyUrl: route.proxyUrl! }) as any;
    // Force HTTP/SSE for deterministic proxy routing. The upstream Codex
    // adapter otherwise prefers WebSocket, whose proxy path is runtime-specific.
    return provider.streamSimple(model, context, {
      ...effectiveOptions,
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
      return bridgeSecondaryCodexStream(source, model, createAssistantMessageEventStream);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    fastModeEnabled = reconstructFastMode(ctx.sessionManager.getBranch() as any[]);
    publishFastMode(ctx);
  });

  // Codex defaults to xhigh whenever either account is selected. Fast mode is
  // session-scoped and becomes active again when the user returns to a
  // supported Codex model.
  pi.on("model_select", async (event, ctx) => {
    if (
      (event.model.provider === "openai-codex" || event.model.provider === "openai-codex-second") &&
      pi.getThinkingLevel() !== "xhigh"
    ) {
      pi.setThinkingLevel("xhigh");
    }
    publishFastMode(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    fastModeEnabled = reconstructFastMode(ctx.sessionManager.getBranch() as any[]);
    publishFastMode(ctx);
  });

  // Compaction can discard older custom markers; re-append the current state
  // so reload/resume can never resurrect a stale Fast setting.
  pi.on("session_compact", () => {
    appendFastModeMarker();
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([transport.close()]);
  });

  pi.registerCommand("fast", {
    description: "Toggle Codex Fast service tier for the current session: /fast [on|off|status]",
    handler: async (args, ctx) => {
      const action = (args ?? "").trim().toLowerCase() || "toggle";
      if (!new Set(["toggle", "on", "off", "status"]).has(action)) {
        ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
        return;
      }
      if (action === "status") {
        const state = publishFastMode(ctx);
        const multiplier = fastCreditMultiplier(state.modelId);
        const detail = state.active
          ? `ON · ${state.provider}/${state.modelId} · priority · ~1.5× speed · ${multiplier ?? "higher"}× ChatGPT credits`
          : state.enabled
            ? `ON (armed) · current model ${state.provider}/${state.modelId || "none"} does not support Fast`
            : "OFF · Standard service tier";
        ctx.ui.notify(`Codex Fast mode: ${detail}`, "info");
        return;
      }

      const enable = action === "on" || (action === "toggle" && !fastModeEnabled);
      if (enable && !isCodexFastModel(ctx.model)) {
        ctx.ui.notify(
          "Fast mode is available only for supported Codex OAuth models (GPT-5.6, GPT-5.5, GPT-5.4). Switch models, then run /fast again.",
          "warning",
        );
        publishFastMode(ctx);
        return;
      }

      const state = setFastMode(enable, ctx);
      if (state.active) {
        const multiplier = fastCreditMultiplier(state.modelId);
        ctx.ui.notify(
          `⚡ Codex Fast mode ON · priority service tier · ~1.5× speed · ${multiplier ?? "higher"}× ChatGPT credits. Run /fast off to return to Standard.`,
          "warning",
        );
      } else {
        ctx.ui.notify("Codex Fast mode OFF · Standard service tier.", "info");
      }
    },
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

  pi.registerCommand("check-claude", {
    description: "测试 claude-custom 连通性",
    handler: async (_args, ctx) => {
      ctx.ui.notify("⟳ 正在测试 claude-custom...", "info");
      try {
        const apiKey = await ctx.modelRegistry.getApiKeyForProvider("claude-custom");
        const headers = new Headers();
        headers.set("Content-Type", "application/json");
        headers.set("anthropic-version", "2023-06-01");
        headers.set("x-api-key", apiKey ?? "");
        headers.set("x-claude-code-session-id", claudeSessionId);
        headers.set("user-agent", "claude-code/1.0");
        const body = JSON.stringify({
          model: claudeRoute.requestModelId,
          max_tokens: 32,
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15_000);
        let resp: Response;
        try {
          resp = await transport.fetch(claudeRoute.baseUrl + "/v1/messages", {
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
          ctx.ui.notify(`✅ claude-custom 正常 (HTTP ${status}, 流式响应有序)`, "info");
        } else {
          const msg = text.match(/"message":"([^"]{1,120})"/)?.[1] ?? text.slice(0, 200);
          ctx.ui.notify(`❌ claude-custom 异常: HTTP ${status} — ${msg}`, "error");
        }
      } catch (e: any) {
        ctx.ui.notify(`❌ claude-custom 连接失败: ${String(e?.message ?? e).slice(0, 200)}`, "error");
      }
    },
  });
}

export default function providerRouting(pi: ExtensionAPI) {
  registerProviderRouting(pi);
}
