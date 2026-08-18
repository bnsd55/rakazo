import { describe, expect, it } from "vitest";
import { buildPlaybookFromRecording } from "./teach-playbook.js";

describe("buildPlaybookFromRecording", () => {
  it("turns pointer and typing events into steps", () => {
    const playbook = buildPlaybookFromRecording(
      "Export weekly CRM list",
      [
        { at: "2026-01-01T00:00:00.000Z", kind: "pointer", x: 120, y: 40, type: "click" },
        { at: "2026-01-01T00:00:01.000Z", kind: "clipboard", text: "weekly-export.csv" },
      ],
      [{ at: "2026-01-01T00:00:02.000Z", summary: "Export dialog open" }],
    );

    expect(playbook.steps.some((step) => step.includes("Click"))).toBe(true);
    expect(playbook.steps.some((step) => step.includes("weekly-export.csv"))).toBe(true);
    expect(playbook.whenToUse).toContain("Export weekly CRM list");
    expect(playbook.approvalBoundaries.length).toBeGreaterThan(0);
    expect(playbook.failureHandling.length).toBeGreaterThan(0);
  });

  it("fills approval and failure fields when the demo lacked them", () => {
    const playbook = buildPlaybookFromRecording("Save a note", []);
    expect(playbook.approvalBoundaries).toContain("approval");
    expect(playbook.failureHandling).toContain("stop");
    expect(playbook.steps.length).toBeGreaterThan(0);
  });

  it("redacts obvious password-like input", () => {
    const playbook = buildPlaybookFromRecording("Sign in", [
      { at: "2026-01-01T00:00:00.000Z", kind: "clipboard", text: "my-password" },
    ]);
    expect(playbook.steps.join(" ")).toContain("[redacted input]");
  });
});
