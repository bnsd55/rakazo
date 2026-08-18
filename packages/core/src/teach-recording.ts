export const DEFAULT_TEACH_RECORDING_TTL_MS = 10 * 60 * 1000;

export function teachRecordingTtlMs(): number {
  const raw = Number(process.env.TEACH_RECORDING_TTL_MS ?? DEFAULT_TEACH_RECORDING_TTL_MS);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : DEFAULT_TEACH_RECORDING_TTL_MS;
}

const SPECIAL_TEACH_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "Delete",
  "Home",
  "End",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
]);

export function teachCaptureKey(
  key: string,
  modifiers?: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean },
): string | null {
  if (modifiers?.metaKey || modifiers?.ctrlKey || modifiers?.altKey) return null;
  if (key.length === 1) return key;
  return SPECIAL_TEACH_KEYS.has(key) ? key : null;
}
