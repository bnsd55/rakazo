import { approvalEffectKey } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  approvalPausedToolResult,
  isApprovalPausedResult,
  resolveDuplicateEffectGate,
} from "./approval-effect.js";

describe("approvalEffectKey", () => {
  it("is stable across arg key order", () => {
    const left = approvalEffectKey("run-1", "destination.write", {
      collection: "notes",
      title: "Result",
      body: "hello",
    });
    const right = approvalEffectKey("run-1", "destination.write", {
      body: "hello",
      collection: "notes",
      title: "Result",
    });
    expect(left).toBe(right);
  });

  it("differs when args change", () => {
    const first = approvalEffectKey("run-1", "destination.write", { body: "one" });
    const second = approvalEffectKey("run-1", "destination.write", { body: "two" });
    expect(first).not.toBe(second);
  });
});

describe("resolveDuplicateEffectGate", () => {
  it("executes only after approval", () => {
    expect(resolveDuplicateEffectGate({ status: "approved" }, "archive_bot")).toEqual({
      action: "execute",
    });
  });

  it("returns denial without executing", () => {
    expect(resolveDuplicateEffectGate({ status: "denied" }, "destination.write")).toEqual({
      action: "return",
      result: { error: "User denied this action." },
    });
  });

  it("returns paused for intended effects instead of executing", () => {
    expect(resolveDuplicateEffectGate({ status: "intended" }, "archive_bot")).toEqual({
      action: "paused",
    });
    expect(resolveDuplicateEffectGate({ status: "intended" }, "delete_bot")).toEqual({
      action: "paused",
    });
  });
});

describe("approvalPausedToolResult", () => {
  it("returns a terminating agent tool result", () => {
    const paused = approvalPausedToolResult();
    expect(isApprovalPausedResult(paused)).toBe(true);
    expect(paused).toMatchObject({
      kind: "agent_tool_result",
      terminate: true,
      details: { approval: "paused" },
    });
    expect(isApprovalPausedResult({ ok: true })).toBe(false);
  });
});
