import { describe, expect, it } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import {
  allocateExtraDisplayCommand,
  ExtraDisplayAllocator,
  extraDisplayLayout,
  parseAllocatedExtraDisplay,
  parseExtraDisplayViewPassword,
  parseReleasedExtraDisplay,
  releaseExtraDisplayCommand,
} from "./extra-displays.js";

describe("extra display ports", () => {
  it("keeps the vendor primary on index 0 and shifts extra screens by two", () => {
    expect(extraDisplayLayout(0, ":0")).toMatchObject({
      display: ":0",
      viewPort: 6080,
      controlPort: 6081,
      isPrimary: true,
    });
    expect(extraDisplayLayout(1, ":0")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
      isPrimary: false,
    });
    expect(extraDisplayLayout(1, ":99")).toMatchObject({
      display: ":2",
      viewPort: 6082,
      controlPort: 6083,
    });
  });

  it("allocates and reuses eight Team screens per sandbox", () => {
    const allocator = new ExtraDisplayAllocator();
    for (let index = 0; index < 8; index += 1) {
      expect(allocator.resolve("sandbox-1", `bot-${index}`)).toBe(index);
    }
    expect(() => allocator.resolve("sandbox-1", "bot-8")).toThrow(ComputerScreenUnavailableError);
    expect(allocator.release("sandbox-1", "bot-3")).toBe(3);
    expect(allocator.resolve("sandbox-1", "bot-8")).toBe(3);
  });

  it("fences release when a newer run has reclaimed the same bot screen", () => {
    const allocator = new ExtraDisplayAllocator();
    expect(allocator.resolve("sandbox-1", "writer", "run-1:1")).toBe(0);
    expect(allocator.resolve("sandbox-1", "writer", "run-2:2")).toBe(0);
    expect(allocator.release("sandbox-1", "writer", "run-1:1")).toBeUndefined();
    expect(allocator.resolve("sandbox-1", "researcher")).toBe(1);
    expect(allocator.release("sandbox-1", "writer", "run-2:2")).toBe(0);
  });

  it("releases a retained screen when the same run resumes without another graphical op", () => {
    const allocator = new ExtraDisplayAllocator();
    expect(allocator.resolve("sandbox-1", "writer", "run-1:1")).toBe(0);
    expect(allocator.release("sandbox-1", "writer", "run-1:8")).toBe(0);
    expect(allocator.resolve("sandbox-1", "researcher")).toBe(0);
  });

  it("does not let a delayed request restore an older lease", () => {
    const allocator = new ExtraDisplayAllocator();
    expect(allocator.resolve("sandbox-1", "writer", "run-2:2")).toBe(0);
    expect(() => allocator.resolve("sandbox-1", "writer", "run-1:1")).toThrow(
      ComputerScreenUnavailableError,
    );
    expect(allocator.release("sandbox-1", "writer", "run-1:1")).toBeUndefined();
    expect(allocator.release("sandbox-1", "writer", "run-2:2")).toBe(0);
  });

  it("uses a locked sandbox registry for cross-process screen assignment", () => {
    const allocate = allocateExtraDisplayCommand("writer", "run-2:2");
    const release = releaseExtraDisplayCommand("writer", "run-2:2");
    expect(allocate).toContain("flock 9");
    expect(allocate).not.toContain("writer");
    expect(release).toContain("RAKAZO_SCREEN_RELEASE=stale");
    expect(release.indexOf("pkill -f")).toBeLessThan(release.indexOf('rm -f "$slot"'));
    expect(parseAllocatedExtraDisplay("RAKAZO_SCREEN_INDEX=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=3\n")).toBe(3);
    expect(parseReleasedExtraDisplay("RAKAZO_SCREEN_RELEASE=stale\n")).toBeUndefined();
  });

  it("requires an authenticated password for view-only VNC", () => {
    expect(parseExtraDisplayViewPassword("RAKAZO_SCREEN_PASSWORD=sandbox_secret-1\n")).toBe(
      "sandbox_secret-1",
    );
    expect(() => parseExtraDisplayViewPassword("no password\n")).toThrow(
      ComputerScreenUnavailableError,
    );
  });
});
