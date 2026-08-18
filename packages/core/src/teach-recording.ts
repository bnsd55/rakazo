export const DEFAULT_TEACH_RECORDING_TTL_MS = 10 * 60 * 1000;

export function teachRecordingTtlMs(): number {
  const raw = Number(process.env.TEACH_RECORDING_TTL_MS ?? DEFAULT_TEACH_RECORDING_TTL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_TEACH_RECORDING_TTL_MS;
}
