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

/**
 * Wraps an SSE response body stream and injects a synthetic `message_delta`
 * with `stop_reason: "end_turn"` before `message_stop` if the upstream proxy
 * didn't send one. This prevents the pi-ai Anthropic parser from throwing
 * "Anthropic stream ended without a stop reason".
 */
function healAnthropicSSE(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawMessageDeltaWithStop = false;

  const SYNTHETIC_DELTA =
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n';

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete SSE events (separated by \n\n)
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const eventText = buffer.slice(0, boundary + 2);
        buffer = buffer.slice(boundary + 2);

        // Track if we've seen message_delta with stop_reason
        if (eventText.includes('"message_delta"') && eventText.includes('"stop_reason"')) {
          sawMessageDeltaWithStop = true;
        }

        // Before forwarding message_stop, inject synthetic delta if missing
        if (eventText.includes('"message_stop"') && !sawMessageDeltaWithStop) {
          controller.enqueue(encoder.encode(SYNTHETIC_DELTA));
          sawMessageDeltaWithStop = true;
        }

        controller.enqueue(encoder.encode(eventText));
      }
    },
    flush(controller) {
      // If there's remaining data in buffer, flush it
      if (buffer.length > 0) {
        // Check if we still need to inject the delta
        if (buffer.includes('"message_stop"') && !sawMessageDeltaWithStop) {
          controller.enqueue(encoder.encode(SYNTHETIC_DELTA));
        }
        controller.enqueue(encoder.encode(buffer));
        buffer = "";
      }
      // If stream ended without message_stop but also without stop_reason,
      // inject both events to prevent errors
      if (!sawMessageDeltaWithStop) {
        controller.enqueue(encoder.encode(SYNTHETIC_DELTA));
        controller.enqueue(
          encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'),
        );
      }
    },
  });

  return body.pipeThrough(transform);
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
      const directFetch: typeof fetch = async (input, init) => {
        const headers = new Headers((init as any)?.headers);
        headers.set("x-claude-code-session-id", alibabaSessionId);
        headers.set("user-agent", "claude-code/1.0");
        const response = await undiciFetch(input as any, {
          ...(init as any),
          headers,
          dispatcher: directDispatcher,
        } as any) as any as Response;
        // Wrap response body to heal missing message_delta with stop_reason
        // Alibaba idealab proxy often closes stream without sending message_delta
        if (!response.body) return response;
        const healed = healAnthropicSSE(response.body);
        return new Response(healed, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
      };
      return provider.streamSimple(model, filteredContext, { ...options, env, fetch: directFetch });
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
