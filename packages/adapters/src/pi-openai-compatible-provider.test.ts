import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { OPENAI_COMPATIBLE_PROVIDER_ID } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { listPiCatalog } from "./pi-models.js";
import { parseModelSecret, secretValuesToRedact, serializeModelSecret } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_CATALOG_MODEL_ID,
  openAiCompatibleCatalogProvider,
  probeOpenAiCompatibleModels,
  registerOpenAiCompatibleRuntime,
} from "./pi-openai-compatible-provider.js";

describe("model connect", () => {
  it("serializes keyless openai-compatible credentials", () => {
    const plaintext = buildModelConnectPlaintext({
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      baseUrl: "http://127.0.0.1:8000",
      modelId: "qwen3-4b",
    });
    const parsed = parseModelSecret(plaintext);
    expect(parsed).toEqual({
      kind: "openai_compatible",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    expect(secretValuesToRedact(parsed)).toEqual([]);
  });

  it("still requires hosted providers to supply a real API key", () => {
    expect(() => buildModelConnectPlaintext({ provider: "openrouter", apiKey: "short" })).toThrow(
      /at least 8 characters/,
    );
  });

  it("round-trips optional openai-compatible API keys", () => {
    const secret = {
      kind: "openai_compatible" as const,
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "local-secret",
    };
    const parsed = parseModelSecret(serializeModelSecret(secret));
    expect(parsed).toEqual(secret);
    expect(secretValuesToRedact(parsed)).toEqual(["local-secret"]);
  });
});

describe("openai-compatible provider", () => {
  it("always exposes a catalog provider entry", () => {
    const provider = openAiCompatibleCatalogProvider();
    expect(provider.id).toBe(OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(provider.getModels()[0]?.id).toBe(OPENAI_COMPATIBLE_CATALOG_MODEL_ID);
  });

  it("registers runtime models at the stored base URL", () => {
    const models = registerOpenAiCompatibleRuntime(builtinModels(), {
      modelId: "rapid-mlx",
      baseUrl: "http://127.0.0.1:8000/v1",
    });
    const model = models.getModel(OPENAI_COMPATIBLE_PROVIDER_ID, "rapid-mlx");
    expect(model?.baseUrl).toBe("http://127.0.0.1:8000/v1");
    expect(model?.api).toBe("openai-completions");
  });

  it("probes /v1/models with mocked fetch", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ models: [{ id: "a" }, { id: "b" }] }), { status: 200 });
    await expect(
      probeOpenAiCompatibleModels({ baseUrl: "http://127.0.0.1:8000/v1" }, fetchImpl),
    ).resolves.toEqual(["a", "b"]);
  });

  it("lists openai-compatible in the catalog even without RAKAZO_LOCAL_MODELS", () => {
    delete process.env.RAKAZO_LOCAL_MODELS;
    const entries = listPiCatalog().filter(
      (entry) => entry.provider === OPENAI_COMPATIBLE_PROVIDER_ID,
    );
    expect(entries.length).toBeGreaterThan(0);
  });
});
