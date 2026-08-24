export const OPENAI_COMPATIBLE_BASE_URL_HINT =
  "Use the base URL your server exposes for /v1/models — often http://127.0.0.1:8000/v1 for Rapid-MLX, Ollama, or LM Studio.";

export function openAiCompatibleConnectReady(input: {
  baseUrl: string;
  modelId: string;
  probeModels: string[];
  probedBaseUrl: string | null;
  storedBaseUrl?: string;
}): boolean {
  const trimmedUrl = input.baseUrl.trim();
  const trimmedModel = input.modelId.trim();
  if (!trimmedUrl || !trimmedModel) return false;
  const probeOk = input.probeModels.length > 0 && input.probedBaseUrl === trimmedUrl;
  const storedOk = Boolean(input.storedBaseUrl && input.storedBaseUrl === trimmedUrl);
  return probeOk || storedOk;
}

export function openAiCompatibleProbeSuccessMessage(modelCount: number): string {
  return `Connected — found ${modelCount} model${modelCount === 1 ? "" : "s"}. Pick one below.`;
}
