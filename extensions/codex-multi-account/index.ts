import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Message,
  Model,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";

const PRIMARY_PROVIDER = "openai-codex";
const SECONDARY_PROVIDER = "openai-codex-second";

export function canonicalizeSecondaryCodexMessage(message: Message): Message {
  if (message.role !== "assistant" || message.provider !== SECONDARY_PROVIDER) return message;
  return { ...message, provider: PRIMARY_PROVIDER };
}

function withProvider(message: AssistantMessage, provider: string): AssistantMessage {
  return message.provider === provider ? message : { ...message, provider };
}

function mapEventProvider(event: AssistantMessageEvent, provider: string): AssistantMessageEvent {
  if (event.type === "done") {
    return { ...event, message: withProvider(event.message, provider) };
  }
  if (event.type === "error") {
    return { ...event, error: withProvider(event.error, provider) };
  }
  return { ...event, partial: withProvider(event.partial, provider) };
}

function errorMessage(model: Model<any>, error: unknown): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: SECONDARY_PROVIDER,
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
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

export function bridgeSecondaryCodexStream(
  source: AssistantMessageEventStream,
  model: Model<any>,
  createStream: () => AssistantMessageEventStream,
): AssistantMessageEventStream {
  const output = createStream();
  void (async () => {
    let terminal = false;
    try {
      for await (const event of source) {
        const mapped = mapEventProvider(event, SECONDARY_PROVIDER);
        output.push(mapped);
        if (mapped.type === "done" || mapped.type === "error") terminal = true;
      }
      if (!terminal) {
        output.push({ type: "error", reason: "error", error: errorMessage(model, new Error("Codex stream ended without a terminal event")) });
      }
    } catch (error) {
      output.push({ type: "error", reason: "error", error: errorMessage(model, error) });
    }
  })();
  return output;
}

function oauthInteraction(callbacks: any): any {
  return {
    signal: callbacks.signal ?? new AbortController().signal,
    notify: async (event: any) => {
      switch (event.type) {
        case "auth_url":
          await callbacks.onAuth?.({ url: event.url, instructions: event.instructions });
          break;
        case "device_code":
          await callbacks.onDeviceCode?.({
            verificationUri: event.verificationUri,
            userCode: event.userCode,
            instructions: event.instructions,
          });
          break;
        case "progress":
          callbacks.onProgress?.(event.message);
          break;
        case "info":
          callbacks.onProgress?.([event.title, event.message].filter(Boolean).join(": "));
          break;
      }
    },
    prompt: async (prompt: any) => {
      switch (prompt.type) {
        case "select":
          if (!callbacks.onSelect) throw new Error("OAuth login requires an interactive selection callback");
          return callbacks.onSelect({ message: prompt.message, options: prompt.options });
        case "manual_code":
          if (callbacks.onManualCodeInput) return callbacks.onManualCodeInput();
          if (callbacks.onPrompt) return callbacks.onPrompt({ message: prompt.message });
          throw new Error("OAuth login requires a manual-code input callback");
        case "secret":
        case "text":
          if (!callbacks.onPrompt) throw new Error("OAuth login requires a prompt callback");
          return callbacks.onPrompt({ message: prompt.message });
        default:
          throw new Error(`Unsupported OAuth prompt type: ${prompt.type}`);
      }
    },
  };
}

function legacyCredentials(credential: any): any {
  const { type: _type, ...rest } = credential;
  return rest;
}

export const __testing = {
  canonicalizeSecondaryCodexMessage,
  mapEventProvider,
  legacyCredentials,
};

export default async function codexMultiAccount(pi: ExtensionAPI): Promise<void> {
  const primary = builtinProviders().find((provider) => provider.id === PRIMARY_PROVIDER);
  if (!primary) throw new Error("Built-in openai-codex provider is unavailable");
  if (!("oauth" in primary.auth)) throw new Error("Built-in openai-codex OAuth provider is unavailable");
  const primaryOAuth = primary.auth.oauth;
  const primaryModels = await primary.getModels();
  const models = primaryModels.map((model: any) => {
    const { provider: _provider, baseUrl: _baseUrl, ...definition } = model;
    return definition;
  });

  pi.registerProvider(SECONDARY_PROVIDER, {
    api: "openai-codex-responses",
    baseUrl: primary.baseUrl,
    oauth: {
      name: "OpenAI Codex (Second Account)",
      login: async (callbacks: any) => legacyCredentials(await primaryOAuth.login(oauthInteraction(callbacks))),
      refreshToken: async (credentials: any) =>
        legacyCredentials(await primaryOAuth.refresh({ type: "oauth", ...credentials })),
      // OpenAI Codex uses the OAuth access token directly as its API key.
      getApiKey: (credentials: any) => credentials.access,
    },
    models,
  });
}
