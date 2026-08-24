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
const MAX_MODELS_RESPONSE_BYTES = 64 * 1024;
const MAX_MODEL_IDS = 500;
const MAX_MODEL_ID_LENGTH = 256;

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
          auth: { apiKey: "local" },
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
  const normalized = assertAllowedOpenAiCompatibleUrl(baseUrl).href;
  const apiKey = input.apiKey?.trim();
  return apiKey ? { baseUrl: normalized, modelId, apiKey } : { baseUrl: normalized, modelId };
}

export type OpenAiCompatibleModelsResponse = {
  object?: string;
  data?: Array<{ id?: string }>;
  models?: Array<{ id?: string }>;
};

function probeModelIds(body: OpenAiCompatibleModelsResponse): string[] {
  const entries = Array.isArray(body.data)
    ? body.data
    : Array.isArray(body.models)
      ? body.models
      : null;
  if (!entries) {
    throw new Error("Model server response did not include a models list");
  }
  const ids: string[] = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (id.length > MAX_MODEL_ID_LENGTH || ids.length >= MAX_MODEL_IDS) {
      throw new Error("Model server returned too many or overly long model ids");
    }
    ids.push(id);
  }
  return ids;
}

async function readBoundedJson(response: Response): Promise<OpenAiCompatibleModelsResponse> {
  const declaredSize = Number(response.headers.get("content-length") ?? 0);
  if (declaredSize > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error("Model server response is too large");
  }
  if (!response.body) throw new Error("Model server returned an empty response");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_MODELS_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Model server response is too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  return JSON.parse(text) as OpenAiCompatibleModelsResponse;
}

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
      redirect: "error",
      signal: merged,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new Error("Model server redirects are not allowed");
    }
    if (!response.ok) {
      throw new Error(`Model server returned ${response.status}`);
    }
    const body = await readBoundedJson(response);
    return probeModelIds(body);
  } finally {
    clearTimeout(timeout);
  }
}
