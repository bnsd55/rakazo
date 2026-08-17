import type { ComputerAction, ComputerInput } from "@rakazo/adapter-kit";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import { clampRounded, shellQuote } from "./computer-support.js";

export const TEAM_EXTRA_DISPLAY_LIMIT = 8;

export interface ExtraDisplayLayout {
  index: number;
  display: string;
  displayNumber: number;
  viewPort: number;
  controlPort: number;
  viewVncPort: number;
  controlVncPort: number;
  isPrimary: boolean;
}

export interface ExtraDisplayEnvironment {
  homeDir: string;
  browserProfilesDir: string;
}

export class ExtraDisplayAllocator {
  private readonly assigned = new Map<string, Map<string, number>>();

  resolve(sandboxId: string, screenKey: string): number {
    let slots = this.assigned.get(sandboxId);
    if (!slots) {
      slots = new Map();
      this.assigned.set(sandboxId, slots);
    }
    const existing = slots.get(screenKey);
    if (existing !== undefined) return existing;
    const used = new Set(slots.values());
    for (let index = 0; index < TEAM_EXTRA_DISPLAY_LIMIT; index += 1) {
      if (!used.has(index)) {
        slots.set(screenKey, index);
        return index;
      }
    }
    throw new ComputerScreenUnavailableError();
  }

  release(sandboxId: string, screenKey: string): number | undefined {
    const slots = this.assigned.get(sandboxId);
    if (!slots) return undefined;
    const index = slots.get(screenKey);
    if (index === undefined) return undefined;
    slots.delete(screenKey);
    if (slots.size === 0) this.assigned.delete(sandboxId);
    return index;
  }

  clear(sandboxId: string): void {
    this.assigned.delete(sandboxId);
  }
}

export function extraDisplayLayout(index: number, primaryDisplay: string): ExtraDisplayLayout {
  if (index < 0 || index >= TEAM_EXTRA_DISPLAY_LIMIT) {
    throw new ComputerScreenUnavailableError();
  }
  const viewPort = 6080 + index * 2;
  const controlPort = 6081 + index * 2;
  const viewVncPort = 5900 + index * 2;
  const controlVncPort = 5901 + index * 2;
  if (index === 0) {
    const displayNumber = Number.parseInt(primaryDisplay.replace(":", ""), 10);
    return {
      index,
      display: primaryDisplay,
      displayNumber: Number.isFinite(displayNumber) ? displayNumber : 0,
      viewPort,
      controlPort,
      viewVncPort,
      controlVncPort,
      isPrimary: true,
    };
  }
  return {
    index,
    display: `:${index + 1}`,
    displayNumber: index + 1,
    viewPort,
    controlPort,
    viewVncPort,
    controlVncPort,
    isPrimary: false,
  };
}

export function probeExtraDisplayToolsCommand(): string {
  return [
    "command -v Xvfb >/dev/null",
    "command -v x11vnc >/dev/null",
    "command -v xdotool >/dev/null",
    "command -v scrot >/dev/null || command -v import >/dev/null",
  ].join(" && ");
}

export function ensureExtraDisplayCommand(
  layout: ExtraDisplayLayout,
  env: ExtraDisplayEnvironment,
): string {
  if (layout.isPrimary) {
    throw new Error("ensureExtraDisplayCommand does not apply to the primary display");
  }
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  const log = `/tmp/rakazo/screen-${layout.displayNumber}`;
  const profile = `${env.browserProfilesDir}/chromium-screen-${layout.displayNumber}`;
  const sharedProfile = `${env.browserProfilesDir}/chromium`;
  const tokenFile = `/tmp/rakazo/control-token-${layout.displayNumber}`;
  return [
    `xdpyinfo -display ${layout.display} >/dev/null 2>&1 && exit 0 || true`,
    `mkdir -p /tmp/rakazo ${fluxHome}/.fluxbox /tmp/.X11-unix ${profile}`,
    `rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${layout.displayNumber} ${tokenFile}`,
    `Xvfb ${layout.display} -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >${log}-xvfb.log 2>&1 &`,
    `for i in $(seq 1 100); do xdpyinfo -display ${layout.display} >/dev/null 2>&1 && break; sleep 0.1; done`,
    `xdpyinfo -display ${layout.display} >/dev/null 2>&1 || exit 1`,
    `if command -v fluxbox >/dev/null 2>&1; then HOME=${fluxHome} DISPLAY=${layout.display} fluxbox >${log}-fluxbox.log 2>&1 & fi`,
    `if [ -d ${shellQuote(sharedProfile)} ]; then cp -a ${shellQuote(sharedProfile)}/. ${shellQuote(profile)}/; rm -f ${profile}/SingletonLock ${profile}/SingletonCookie ${profile}/SingletonSocket; fi`,
    `for browser in google-chrome google-chrome-stable chromium chromium-browser firefox; do`,
    `  if command -v "$browser" >/dev/null 2>&1; then`,
    `    DISPLAY=${layout.display} HOME=${shellQuote(env.homeDir)} "$browser" --user-data-dir=${shellQuote(profile)} >${log}-browser.log 2>&1 &`,
    `    break`,
    `  fi`,
    `done`,
    `x11vnc -display ${layout.display} -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport ${layout.viewVncPort} -xkb -ncache 0 >${log}-x11vnc.log 2>&1 &`,
    `if command -v websockify >/dev/null 2>&1; then`,
    `  websockify --web=/usr/share/novnc 0.0.0.0:${layout.viewPort} 127.0.0.1:${layout.viewVncPort} >${log}-novnc.log 2>&1 &`,
    `elif [ -d /opt/noVNC/utils ]; then`,
    `  (cd /opt/noVNC/utils && nohup ./novnc_proxy --vnc localhost:${layout.viewVncPort} --listen ${layout.viewPort} --web /opt/noVNC >${log}-novnc.log 2>&1 &)`,
    `else`,
    `  exit 1`,
    `fi`,
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${layout.viewPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "exit 1",
  ].join("; ");
}

export function stopExtraDisplayCommand(layout: ExtraDisplayLayout): string {
  if (layout.isPrimary) return "";
  const fluxHome = `/tmp/fluxbox-home-${layout.displayNumber}`;
  const profile = `${layout.display.replace(":", "")}`;
  return [
    `pkill -f 'Xvfb ${layout.display} -screen' || true`,
    `pkill -f 'HOME=${fluxHome} DISPLAY=${layout.display} fluxbox' || true`,
    `pkill -f -- 'chromium-screen-${layout.displayNumber}' || true`,
    `pkill -f '^x11vnc .* -rfbport ${layout.viewVncPort}' || true`,
    `pkill -f '^x11vnc .* -rfbport ${layout.controlVncPort}' || true`,
    `pkill -f '^/usr/bin/python3 .*websockify.*${layout.viewPort}' || true`,
    `pkill -f 'novnc_proxy.*--listen ${layout.viewPort}' || true`,
    `rm -f /tmp/.X${layout.displayNumber}-lock /tmp/.X11-unix/X${profile} /tmp/rakazo/control-token-${layout.displayNumber}`,
  ].join("; ");
}

export function extraDisplayControlStartCommand(
  layout: ExtraDisplayLayout,
  controlToken: string,
  password: string,
): string {
  const passwordFile = `/tmp/rakazo-control-${layout.displayNumber}.vncpass`;
  const tokenFile = `/tmp/rakazo/control-token-${layout.displayNumber}`;
  const log = `/tmp/rakazo/screen-${layout.displayNumber}`;
  return [
    extraDisplayControlStopCommand(layout, controlToken),
    `mkdir -p /tmp/rakazo`,
    `printf %s ${shellQuote(controlToken)} > ${tokenFile}`,
    `x11vnc -storepasswd ${shellQuote(password)} ${passwordFile} >/dev/null`,
    `x11vnc -bg -display ${shellQuote(layout.display)} -forever -wait 50 -shared -rfbport ${layout.controlVncPort} -rfbauth ${passwordFile} 2>${log}-control-x11vnc.log`,
    "if command -v websockify >/dev/null 2>&1; then",
    `  (nohup websockify --web=/usr/share/novnc 0.0.0.0:${layout.controlPort} 127.0.0.1:${layout.controlVncPort} >${log}-control-novnc.log 2>&1 &)`,
    "elif [ -d /opt/noVNC/utils ]; then",
    `  (cd /opt/noVNC/utils && nohup ./novnc_proxy --vnc localhost:${layout.controlVncPort} --listen ${layout.controlPort} --web /opt/noVNC >${log}-control-novnc.log 2>&1 &)`,
    "else",
    "  exit 1",
    "fi",
    `for i in $(seq 1 50); do (echo >/dev/tcp/127.0.0.1/${layout.controlPort}) >/dev/null 2>&1 && exit 0; sleep 0.1; done`,
    "exit 1",
  ].join(" && ");
}

export function extraDisplayControlStopCommand(
  layout: ExtraDisplayLayout,
  controlToken?: string,
): string {
  const stop = [
    `pkill -f '^x11vnc .* -rfbport ${layout.controlVncPort}' || true`,
    `pkill -f '^/usr/bin/python3 .*websockify.*${layout.controlPort}' || true`,
    `pkill -f 'novnc_proxy.*--listen ${layout.controlPort}' || true`,
    `rm -f /tmp/rakazo-control-${layout.displayNumber}.vncpass`,
    `rm -f /tmp/rakazo/control-token-${layout.displayNumber}`,
  ].join("; ");
  if (!controlToken) return stop;
  return `[ -f /tmp/rakazo/control-token-${layout.displayNumber} ] && [ "$(cat /tmp/rakazo/control-token-${layout.displayNumber})" != ${shellQuote(controlToken)} ] || { ${stop}; }`;
}

export function observeExtraDisplayCommand(layout: ExtraDisplayLayout): string {
  const imagePath = `/tmp/rakazo/observe-${layout.displayNumber}.png`;
  return [
    `DISPLAY=${layout.display} xdotool getmouselocation --shell 2>/tmp/rakazo/cursor-${layout.displayNumber}.txt || true`,
    `DISPLAY=${layout.display} scrot -o ${imagePath} 2>/dev/null || DISPLAY=${layout.display} import -window root ${imagePath}`,
    `test -s ${imagePath}`,
    `base64 -w0 ${imagePath} 2>/dev/null || base64 ${imagePath}`,
    `printf '\\nCURSOR '`,
    `tr '\\n' ' ' </tmp/rakazo/cursor-${layout.displayNumber}.txt 2>/dev/null || true`,
  ].join("; ");
}

export function parseExtraDisplayObservation(output: string): {
  image: Uint8Array;
  cursor?: { x: number; y: number };
} {
  const cursorLine = output.match(/X=(\d+).*Y=(\d+)/);
  const base64Line =
    output
      .split(/\nCURSOR /)[0]
      ?.trim()
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "";
  const image = Uint8Array.from(Buffer.from(base64Line, "base64"));
  if (!image.byteLength) throw new Error("extra display observation did not capture an image");
  return {
    image,
    ...(cursorLine
      ? { cursor: { x: Number(cursorLine[1]), y: Number(cursorLine[2]) } }
      : {}),
  };
}

export function extraDisplayActionCommand(layout: ExtraDisplayLayout, action: ComputerAction): string {
  if (action.kind === "wait") {
    return `sleep ${clampRounded(action.ms, 0, 5_000) / 1000}`;
  }
  if (action.kind === "scroll") {
    const repeat = clampRounded(action.amount ?? 3, 1, 20);
    const button = action.direction === "up" ? "4" : "5";
    return `DISPLAY=${layout.display} xdotool click --repeat ${repeat} ${button}`;
  }
  if (action.kind === "key") {
    const keys = [...(action.modifiers ?? []), action.key].join("+");
    return `DISPLAY=${layout.display} xdotool key ${shellQuote(keys)}`;
  }
  if (action.kind === "clipboard") {
    return `DISPLAY=${layout.display} xdotool type ${shellQuote(action.text)}`;
  }
  if (action.kind === "pointer") {
    const button = action.button === "right" ? "3" : "1";
    if (action.type === "move") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y}`;
    }
    if (action.type === "down") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} mousedown ${button}`;
    }
    if (action.type === "up") {
      return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} mouseup ${button}`;
    }
    return `DISPLAY=${layout.display} xdotool mousemove ${action.x} ${action.y} click ${button}`;
  }
  if (action.kind === "open") {
    const target = /^https?:\/\//i.test(action.path) ? action.path : action.path;
    return `DISPLAY=${layout.display} xdg-open ${shellQuote(target)}`;
  }
  return `DISPLAY=${layout.display} ${shellQuote(action.application)}${action.uri ? ` ${shellQuote(action.uri)}` : ""}`;
}

export function extraDisplayInputCommand(layout: ExtraDisplayLayout, input: ComputerInput): string {
  if (input.kind === "key") {
    return `DISPLAY=${layout.display} xdotool key ${shellQuote(input.key)}`;
  }
  if (input.kind === "clipboard") {
    return `DISPLAY=${layout.display} xdotool type ${shellQuote(input.text)}`;
  }
  const button = input.button === "right" ? "3" : "1";
  if (input.type === "move") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y}`;
  }
  if (input.type === "down") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} mousedown ${button}`;
  }
  if (input.type === "up") {
    return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} mouseup ${button}`;
  }
  return `DISPLAY=${layout.display} xdotool mousemove ${input.x} ${input.y} click ${button}`;
}

export function primaryStreamCleanupCommand(primaryViewPort = 6080): string {
  return [
    "pkill -f '^x11vnc .* -R viewonly' || true",
    `pkill -f '[n]ovnc_proxy.*${primaryViewPort}' || true`,
    `pkill -f '[w]ebsockify.*${primaryViewPort}' || true`,
  ].join("; ");
}

export function screenControlKey(sandboxId: string, screenKey: string): string {
  return `${sandboxId}:${screenKey}`;
}
