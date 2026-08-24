import type { ModelConnectInput } from "@rakazo/contracts";
import type { StoredModelSecret } from "./pi-oauth.js";
import { serializeModelSecret } from "./pi-oauth.js";
import {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  prepareOpenAiCompatibleConnect,
} from "./pi-openai-compatible-provider.js";

export function buildModelConnectPlaintext(input: ModelConnectInput): string {
  if (input.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
    const prepared = prepareOpenAiCompatibleConnect(input);
    const secret: StoredModelSecret = {
      kind: "openai_compatible",
      baseUrl: prepared.baseUrl,
      ...(prepared.apiKey ? { apiKey: prepared.apiKey } : {}),
    };
    return serializeModelSecret(secret);
  }
  const apiKey = input.apiKey?.trim();
  if (!apiKey || apiKey.length < 8) {
    throw new Error("API key must contain at least 8 characters");
  }
  return apiKey;
}
