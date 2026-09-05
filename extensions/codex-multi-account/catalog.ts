import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";

export const PRIMARY_CODEX_PROVIDER = "openai-codex";
export const SECONDARY_CODEX_PROVIDER = "openai-codex-second";
export const CODEX_CATALOG_URL = "https://pi.dev/api/models/providers/openai-codex";

const MAX_MODELS = 128;
const MAX_MODEL_ID = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_MODEL_ID && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value);
}

function projectCost(value: unknown): ProviderModelConfig["cost"] | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    if (!finiteNonNegative(value[key])) return undefined;
  }
  const tiers = Array.isArray(value.tiers)
    ? value.tiers
      .filter((tier) => isRecord(tier))
      .map((tier) => ({
        inputTokensAbove: tier.inputTokensAbove,
        input: tier.input,
        output: tier.output,
        cacheRead: tier.cacheRead,
        cacheWrite: tier.cacheWrite,
      }))
      .filter((tier) => finiteNonNegative(tier.inputTokensAbove) && finiteNonNegative(tier.input) && finiteNonNegative(tier.output) && finiteNonNegative(tier.cacheRead) && finiteNonNegative(tier.cacheWrite))
    : undefined;
  return {
    input: value.input as number,
    output: value.output as number,
    cacheRead: value.cacheRead as number,
    cacheWrite: value.cacheWrite as number,
    ...(tiers?.length ? { tiers } : {}),
  };
}

/** Project a trusted Pi catalog model into the extension provider model schema. */
export function projectCodexModel(value: unknown): ProviderModelConfig | undefined {
  if (!isRecord(value) || !safeId(value.id)) return undefined;
  if (typeof value.name !== "string" || !value.name || value.name.length > 256) return undefined;
  if (value.api !== "openai-codex-responses") return undefined;
  if (typeof value.reasoning !== "boolean" || !finitePositive(value.contextWindow) || !finitePositive(value.maxTokens)) return undefined;
  if (!Array.isArray(value.input) || value.input.length === 0 || value.input.some((entry) => entry !== "text" && entry !== "image")) return undefined;
  const cost = projectCost(value.cost);
  if (!cost) return undefined;
  const thinkingLevelMap = isRecord(value.thinkingLevelMap)
    ? Object.fromEntries(Object.entries(value.thinkingLevelMap).filter(([, mapped]) => mapped === null || typeof mapped === "string"))
    : undefined;
  const compat = isRecord(value.compat) ? { ...value.compat } : undefined;
  const samplingParams = isRecord(value.samplingParams) ? { ...value.samplingParams } : undefined;
  return {
    id: value.id,
    name: value.name,
    api: "openai-codex-responses",
    reasoning: value.reasoning,
    input: [...value.input] as ("text" | "image")[],
    cost,
    contextWindow: value.contextWindow,
    maxTokens: value.maxTokens,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    ...(compat ? { compat } : {}),
    ...(samplingParams ? { samplingParams } : {}),
  };
}

export function parseCodexCatalog(payload: unknown): ProviderModelConfig[] {
  const values = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.models)
      ? payload.models
      : isRecord(payload)
        ? Object.values(payload)
        : [];
  if (values.length === 0 || values.length > MAX_MODELS) throw new Error("OpenAI Codex catalog size was invalid");
  const projected = values.map(projectCodexModel).filter((model): model is ProviderModelConfig => Boolean(model));
  if (projected.length !== values.length) throw new Error("OpenAI Codex catalog contained an invalid model");
  const unique = new Map<string, ProviderModelConfig>();
  for (const model of projected) unique.set(model.id, model);
  return [...unique.values()];
}

export function mergeCodexModels(base: ProviderModelConfig[], overlay: ProviderModelConfig[]): ProviderModelConfig[] {
  const merged = new Map(base.map((model) => [model.id, model]));
  for (const model of overlay) merged.set(model.id, model);
  return [...merged.values()];
}

function fullStoredModel(model: ProviderModelConfig, baseUrl: string): Model<any> {
  return {
    ...model,
    provider: SECONDARY_CODEX_PROVIDER,
    baseUrl,
  } as Model<any>;
}

export function readStoredCodexModels(agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent")): ProviderModelConfig[] {
  try {
    const payload = JSON.parse(fs.readFileSync(path.join(agentDir, "models-store.json"), "utf8")) as Record<string, unknown>;
    const entries = [SECONDARY_CODEX_PROVIDER, PRIMARY_CODEX_PROVIDER]
      .map((provider) => payload[provider])
      .filter((entry): entry is Record<string, unknown> => isRecord(entry) && Array.isArray(entry.models))
      .map((entry) => ({
        checkedAt: typeof entry.checkedAt === "number" && Number.isFinite(entry.checkedAt) ? entry.checkedAt : 0,
        models: (entry.models as unknown[]).map(projectCodexModel).filter((model): model is ProviderModelConfig => Boolean(model)),
      }))
      .filter((entry) => entry.models.length > 0)
      .sort((left, right) => left.checkedAt - right.checkedAt);
    return entries.reduce<ProviderModelConfig[]>((models, entry) => mergeCodexModels(models, entry.models), []);
  } catch {
    // Static built-in models remain the safe fallback.
    return [];
  }
}

export async function refreshSecondaryCodexModels(
  context: RefreshModelsContext,
  baseUrl: string,
  fallback: ProviderModelConfig[],
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
  const stored = context.stored?.models
    ?.map(projectCodexModel)
    .filter((model): model is ProviderModelConfig => Boolean(model)) ?? [];
  const cached = stored.length > 0 ? stored : fallback;
  if (!context.allowNetwork || context.signal.aborted) return cached;

  const validator = stored.length > 0 ? context.stored?.etag : undefined;
  const response = await fetchImpl(CODEX_CATALOG_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "pi-codex-multi-account/1.0",
      ...(validator ? { "if-none-match": validator } : {}),
    },
    signal: context.signal,
  });
  if (context.signal.aborted) return cached;
  const checkedAt = Date.now();
  if (response.status === 304 && context.stored) {
    await context.publish({ persist: { ...context.stored, checkedAt } });
    return cached;
  }
  if (!response.ok) throw new Error(`Second Codex model catalog request failed: HTTP ${response.status}`);
  const models = parseCodexCatalog(await response.json());
  const lastModified = Date.parse(response.headers.get("last-modified") ?? "");
  await context.publish({
    persist: {
      models: models.map((model) => fullStoredModel(model, baseUrl)),
      checkedAt,
      lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
      etag: response.headers.get("etag") ?? undefined,
    },
  });
  return models;
}
