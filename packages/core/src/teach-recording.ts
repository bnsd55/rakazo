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

export const DEFAULT_COMPUTER_SCREEN = { width: 1280, height: 800 } as const;
export const BOX_COMPUTER_SCREEN = { width: 1920, height: 1080 } as const;

export function computerScreenSize(kind: string | null | undefined): {
  width: number;
  height: number;
} {
  return kind === "box" ? BOX_COMPUTER_SCREEN : DEFAULT_COMPUTER_SCREEN;
}

export function mapTeachPointer(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
  screen: { width: number; height: number },
): { x: number; y: number } {
  const width = rect.width || 1;
  const height = rect.height || 1;
  return {
    x: Math.round(((clientX - rect.left) / width) * screen.width),
    y: Math.round(((clientY - rect.top) / height) * screen.height),
  };
}
