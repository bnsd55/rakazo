import type { TaughtSkill } from "@rakazo/contracts";
import { DEFAULT_COMPUTER_SCREEN, mapTeachPointer, teachCaptureKey } from "@rakazo/core";
import { useEffect, useRef } from "react";
import { rpc } from "../../lib/rpc";

export function TeachCaptureOverlay({
  botId,
  skill,
  enabled,
  screenWidth,
  screenHeight,
}: {
  botId: string;
  skill: TaughtSkill | null;
  enabled: boolean;
  screenWidth?: number;
  screenHeight?: number;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const inputChainRef = useRef(Promise.resolve());
  const width = screenWidth ?? DEFAULT_COMPUTER_SCREEN.width;
  const height = screenHeight ?? DEFAULT_COMPUTER_SCREEN.height;

  useEffect(() => {
    if (!enabled || !skill || skill.status !== "recording") return;
    const overlay = rootRef.current;
    if (!overlay) return;
    const target: HTMLDivElement = overlay;

    function enqueueInput(task: () => Promise<void>) {
      inputChainRef.current = inputChainRef.current.then(task).catch(() => undefined);
    }

    function pointerAt(event: PointerEvent) {
      return mapTeachPointer(event.clientX, event.clientY, target.getBoundingClientRect(), {
        width,
        height,
      });
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

    async function sendScroll(direction: "up" | "down", amount: number) {
      await rpc.computer.input({
        botId,
        kind: "scroll",
        payload: { direction, amount },
      });
    }

    function buttonFor(event: PointerEvent): "left" | "right" {
      return event.button === 2 ? "right" : "left";
    }

    function onPointerDown(event: PointerEvent) {
      event.preventDefault();
      target.setPointerCapture(event.pointerId);
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendPointer("down", x, y, buttonFor(event)));
    }

    function onPointerMove(event: PointerEvent) {
      if (!event.buttons) return;
      event.preventDefault();
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendPointer("move", x, y, event.buttons === 2 ? "right" : "left"));
    }

    function onPointerUp(event: PointerEvent) {
      event.preventDefault();
      if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
      const { x, y } = pointerAt(event);
      enqueueInput(() => sendPointer("up", x, y, buttonFor(event)));
    }

    function onWheel(event: WheelEvent) {
      event.preventDefault();
      const direction = event.deltaY < 0 ? "up" : "down";
      const amount = Math.min(20, Math.max(1, Math.round(Math.abs(event.deltaY) / 80) || 1));
      enqueueInput(() => sendScroll(direction, amount));
    }

    function onKeyDown(event: KeyboardEvent) {
      const key = teachCaptureKey(event.key, event);
      if (!key) return;
      event.preventDefault();
      enqueueInput(() => sendKey(key));
    }

    function onContextMenu(event: Event) {
      event.preventDefault();
    }

    target.addEventListener("pointerdown", onPointerDown);
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("pointercancel", onPointerUp);
    target.addEventListener("wheel", onWheel, { passive: false });
    target.addEventListener("contextmenu", onContextMenu);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
      target.removeEventListener("wheel", onWheel);
      target.removeEventListener("contextmenu", onContextMenu);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [botId, enabled, height, skill, width]);

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
