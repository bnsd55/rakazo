import {
  createProvider,
  type Model,
  type MutableModels,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import {
  assertAllowedOpenAiCompatibleUrl,
  normalizeOpenAiCompatibleBaseUrl,
  OPENAI_COMPATIBLE_PROVIDER_ID,
} from "./openai-compatible-url.js";

export { OPENAI_COMPATIBLE_PROVIDER_ID };

/** Placeholder catalog model id; users enter the real id when connecting. */
export const OPENAI_COMPATIBLE_CATALOG_MODEL_ID = "custom";

const DEFAULT_CONTEXT_WINDOW = 32_768;
const DEFAULT_MAX_TOKENS = 4_096;

const OPENAI_COMPAT_BASE = "http://127.0.0.1:1/v1";

function openAiCompatibleModel(id: string, baseUrl: string): Model<"openai-completions"> {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: OPENAI_COMPATIBLE_PROVIDER_ID,
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
    compat: {
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
    },
  };
}

function openAiCompatibleProvider(models: Model<"openai-completions">[]): Provider {
  return createProvider({
    id: OPENAI_COMPATIBLE_PROVIDER_ID,
    name: "OpenAI-compatible",
    baseUrl: models[0]?.baseUrl ?? OPENAI_COMPAT_BASE,
    auth: {
      apiKey: {
        name: "OpenAI-compatible server",
        resolve: async () => ({
          auth: { apiKey: "" },
          source: "OpenAI-compatible endpoint",
        }),
      },
    },
    models,
    api: openAICompletionsApi(),
  });
}

/** Always-visible catalog provider with a placeholder model entry. */
export function openAiCompatibleCatalogProvider(): Provider {
  return openAiCompatibleProvider([
    {
      ...openAiCompatibleModel(OPENAI_COMPATIBLE_CATALOG_MODEL_ID, OPENAI_COMPAT_BASE),
      name: "Custom model id",
    },
  ]);
}

export function registerOpenAiCompatibleCatalog(models: MutableModels): MutableModels {
  models.setProvider(openAiCompatibleCatalogProvider());
  return models;
}

/** Register a concrete model + base URL for an agent run. */
export function registerOpenAiCompatibleRuntime(
  models: MutableModels,
  opts: { modelId: string; baseUrl: string },
): MutableModels {
  const baseUrl = normalizeOpenAiCompatibleBaseUrl(opts.baseUrl);
  models.setProvider(
    openAiCompatibleProvider([openAiCompatibleModel(opts.modelId.trim(), baseUrl)]),
  );
  return models;
}

export type OpenAiCompatibleConnectInput = {
  provider: string;
  baseUrl?: string;
  modelId?: string;
  apiKey?: string;
};

export function prepareOpenAiCompatibleConnect(input: OpenAiCompatibleConnectInput): {
  baseUrl: string;
  modelId: string;
  apiKey?: string;
} {
  const baseUrl = input.baseUrl?.trim();
  const modelId = input.modelId?.trim();
  if (!baseUrl) throw new Error("Base URL is required for OpenAI-compatible models");
  if (!modelId) throw new Error("Model id is required for OpenAI-compatible models");
  assertAllowedOpenAiCompatibleUrl(baseUrl);
  const normalized = normalizeOpenAiCompatibleBaseUrl(baseUrl);
  const apiKey = input.apiKey?.trim();
  return apiKey ? { baseUrl: normalized, modelId, apiKey } : { baseUrl: normalized, modelId };
}

export type OpenAiCompatibleModelsResponse = {
  models: Array<{ id: string }>;
};

export async function probeOpenAiCompatibleModels(
  input: { baseUrl: string; apiKey?: string },
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<string[]> {
  const baseUrl = assertAllowedOpenAiCompatibleUrl(input.baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  const merged = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (input.apiKey?.trim()) headers.Authorization = `Bearer ${input.apiKey.trim()}`;
    const response = await fetchImpl(new URL("models", `${baseUrl.href}/`).href, {
      headers,
      signal: merged,
    });
    if (!response.ok) {
      throw new Error(`Model server returned ${response.status}`);
    }
    const body = (await response.json()) as OpenAiCompatibleModelsResponse;
    if (!Array.isArray(body.models)) {
      throw new Error("Model server response did not include a models list");
    }
    return body.models
      .map((entry) => (typeof entry?.id === "string" ? entry.id.trim() : ""))
      .filter((id) => id.length > 0);
  } finally {
    clearTimeout(timeout);
  }
}
