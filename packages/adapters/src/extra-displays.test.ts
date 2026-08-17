import { describe, expect, it } from "vitest";
import { ComputerScreenUnavailableError } from "./computer-screens.js";
import { ExtraDisplayAllocator, extraDisplayLayout } from "./extra-displays.js";

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
});
