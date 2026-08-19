import { describe, expect, it } from "vitest";
import { computerScreenSize, mapTeachPointer, teachCaptureKey } from "./teach-recording.js";

describe("teachCaptureKey", () => {
  it("records printable characters and editing keys", () => {
    expect(teachCaptureKey("a")).toBe("a");
    expect(teachCaptureKey("Enter")).toBe("Enter");
    expect(teachCaptureKey("Backspace")).toBe("Backspace");
    expect(teachCaptureKey("Tab")).toBe("Tab");
    expect(teachCaptureKey("ArrowLeft")).toBe("ArrowLeft");
  });

  it("ignores modifiers and unmapped keys", () => {
    expect(teachCaptureKey("a", { metaKey: true })).toBeNull();
    expect(teachCaptureKey("Shift")).toBeNull();
    expect(teachCaptureKey("F5")).toBeNull();
  });
});

describe("computerScreenSize", () => {
  it("uses box geometry and the 1280x800 default for other sandboxes", () => {
    expect(computerScreenSize("box")).toEqual({ width: 1920, height: 1080 });
    expect(computerScreenSize("e2b")).toEqual({ width: 1280, height: 800 });
    expect(computerScreenSize("daytona")).toEqual({ width: 1280, height: 800 });
  });
});

describe("mapTeachPointer", () => {
  it("scales overlay clicks onto the remote screen size", () => {
    const rect = { left: 0, top: 0, width: 640, height: 400 };
    expect(mapTeachPointer(320, 200, rect, { width: 1280, height: 800 })).toEqual({
      x: 640,
      y: 400,
    });
    expect(mapTeachPointer(320, 200, rect, { width: 1920, height: 1080 })).toEqual({
      x: 960,
      y: 540,
    });
  });
});
