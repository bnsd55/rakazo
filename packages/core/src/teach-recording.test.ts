import { describe, expect, it } from "vitest";
import { teachCaptureKey } from "./teach-recording.js";

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
