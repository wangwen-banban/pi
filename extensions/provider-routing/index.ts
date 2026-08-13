import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Model, SimpleStreamOptions, Context, AssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";


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
  maxRetries: number = 5,
): AssistantMessageEventStream {
  const wrapper = createStream();
  (async () => {
    let lastError: any;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      let contentStarted = false;
      try {
        const inner = await makeStream();
        for await (const event of inner) {
          const errMsg = event.error?.errorMessage ?? event.error?.message ?? "";

          // --- Retryable error (typically before content) ---
          if (event.type === "error" && !contentStarted && matchesAny(errMsg, RETRYABLE_PATTERNS)) {
            lastError = event;
            const delay = retryDelay(attempt);
            // console.error(`[alibaba-relay] Retryable error (attempt ${attempt + 1}/${maxRetries + 1}), retrying in ${Math.round(delay)}ms: ${errMsg}`);
            await sleep(delay);
            break; // break inner loop → retry
          }

          // --- Healable stream error (content was delivered, just fix stop) ---
          if (event.type === "error" && matchesAny(errMsg, HEALABLE_PATTERNS)) {
            const output = event.error;
            output.stopReason = "end_turn";
            delete output.errorMessage;
            wrapper.push({ type: "done", reason: "end_turn", message: output });
            return;
          }

          // --- Non-retryable error ---
          if (event.type === "error") {
            wrapper.push(event);
            return;
          }

          // --- Normal event: forward and track content ---
          if (event.type !== "done") {
            contentStarted = true;
          }
          wrapper.push(event);

          // Success
          if (event.type === "done") return;
        }

        // If we exhausted the inner stream without done/error (shouldn't happen normally)
        // This means we broke out for retry — continue the for loop
      } catch (err: any) {
        // makeStream() itself threw (e.g. network error)
        const errMsg = err?.message ?? String(err);
        if (attempt < maxRetries && matchesAny(errMsg, RETRYABLE_PATTERNS)) {
          lastError = err;
          await sleep(retryDelay(attempt));
          continue;
        }
        wrapper.push({ type: "error", reason: "error", error: err });
        return;
      }
    }
    // All retries exhausted
    if (lastError) {
      wrapper.push(lastError);
    } else {
      wrapper.push({ type: "error", reason: "error", error: { errorMessage: `Retry exhausted after ${maxRetries + 1} attempts` } });
    }
  })();
  return wrapper;
}

export default function providerRouting(pi: ExtensionAPI) {
  const requireFromPi = createRequire(`${PI_ROOT}/dist/cli.js`);
  const { Agent, ProxyAgent, fetch: undiciFetch } = requireFromPi("undici") as {
    Agent: new () => { close(): Promise<void> };
    ProxyAgent: new (uri: string) => { close(): Promise<void> };
    fetch: typeof fetch;
  };
  const directDispatcher = new Agent();
  const proxyDispatchers = new Map<string, { close(): Promise<void> }>();
  const proxyDispatcherFor = (url: string) => {
    let dispatcher = proxyDispatchers.get(url);
    if (!dispatcher) {
      dispatcher = new ProxyAgent(url);
      proxyDispatchers.set(url, dispatcher);
    }
    return dispatcher;
  };
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
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (Alibaba Relay)",
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
      // Inject identity headers + skip TLS verification for internal endpoint
      const directFetch: typeof fetch = (input, init) => {
        const headers = new Headers((init as any)?.headers);
        headers.set("x-claude-code-session-id", alibabaSessionId);
        headers.set("user-agent", "claude-code/1.0");
        return undiciFetch(input as any, {
          ...(init as any),
          headers,
          dispatcher: directDispatcher,
        } as any) as any;
      };
      const { createAssistantMessageEventStream } = await import(
        `${PI_ROOT}/node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`
      );
      return streamWithRetry(
        () => provider.streamSimple(model, filteredContext, { ...options, env, fetch: directFetch }),
        createAssistantMessageEventStream,
        5, // max 5 retries
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
        undiciFetch(input as any, { ...(init as any), dispatcher: directDispatcher } as any) as any;
      return provider.streamSimple(requestModel, context, { ...options, env, fetch: directFetch });
    },
  });

  // Override only the transport of the built-in Codex provider. OAuth, model
  // discovery, payload shaping, and response parsing remain provided by pi-ai.
  pi.registerProvider("openai-codex", {
    api: "openai-codex-responses",
    streamSimple: async (
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

      const dispatcher = proxyDispatcherFor(route.proxyUrl!);
      const routedFetch: typeof fetch = (input, init) =>
        undiciFetch(input as any, { ...(init as any), dispatcher } as any) as any;
      // Force HTTP/SSE for deterministic proxy routing. The upstream Codex
      // adapter otherwise prefers WebSocket, whose proxy path is runtime-specific.
      return provider.streamSimple(model, context, {
        ...options,
        env,
        fetch: routedFetch,
        transport: "sse",
      });
    },
  });

  // Codex defaults to xhigh whenever selected. Other providers keep their own level.
  pi.on("model_select", async (event) => {
    if (event.model.provider === "openai-codex" && pi.getThinkingLevel() !== "xhigh") {
      pi.setThinkingLevel("xhigh");
    }
  });

  pi.on("session_shutdown", async () => {
    await Promise.allSettled([
      directDispatcher.close(),
      ...Array.from(proxyDispatchers.values(), (dispatcher) => dispatcher.close()),
    ]);
    proxyDispatchers.clear();
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
}
