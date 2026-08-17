import { describe, expect, it } from "vitest";
import { approvalEffectKey, stableJsonValue } from "./approval-effect-key.js";

describe("stableJsonValue", () => {
  it("sorts object keys", () => {
    expect(stableJsonValue({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});

describe("approvalEffectKey", () => {
  it("includes run, tool, and canonical args", () => {
    expect(approvalEffectKey("run-1", "destination.write", { body: "x" })).toBe(
      'run-1:destination.write:{"body":"x"}',
    );
  });
});
