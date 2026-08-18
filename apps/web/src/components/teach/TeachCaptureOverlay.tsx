import type { TaughtSkill } from "@rakazo/contracts";
import { teachCaptureKey } from "@rakazo/core";
import { useEffect, useRef } from "react";
import { rpc } from "../../lib/rpc";

export function TeachCaptureOverlay({
  botId,
  skill,
  enabled,
}: {
  botId: string;
  skill: TaughtSkill | null;
  enabled: boolean;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputChainRef = useRef(Promise.resolve());

  useEffect(() => {
    if (!enabled || !skill || skill.status !== "recording") return;
    const root = rootRef.current;
    if (!root) return;

    function enqueueInput(task: () => Promise<void>) {
      inputChainRef.current = inputChainRef.current.then(task).catch(() => undefined);
    }

    async function sendPointer(
      type: "move" | "down" | "up" | "click",
      x: number,
      y: number,
      button: "left" | "right" = "left",
    ) {
      await rpc.computer.input({
        botId,
        kind: "pointer",
        payload: { x, y, button, type },
      });
    }

    async function sendKey(key: string) {
      await rpc.computer.input({ botId, kind: "key", payload: { key } });
    }

    function onPointerDown(event: PointerEvent) {
      event.preventDefault();
      const target = root;
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const x = Math.round(((event.clientX - rect.left) / rect.width) * 1280);
      const y = Math.round(((event.clientY - rect.top) / rect.height) * 800);
      enqueueInput(() => sendPointer("click", x, y, event.button === 2 ? "right" : "left"));
    }

    function onKeyDown(event: KeyboardEvent) {
      const key = teachCaptureKey(event.key, event);
      if (!key) return;
      event.preventDefault();
      enqueueInput(() => sendKey(key));
    }

    root.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      root.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [botId, enabled, skill]);

  if (!enabled || !skill || skill.status !== "recording") return null;

  return (
    <div
      ref={rootRef}
      data-testid="teach-capture-overlay"
      role="presentation"
      className="absolute inset-0 z-10 cursor-crosshair bg-transparent"
    />
  );
}
