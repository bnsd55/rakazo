import { describe, expect, it } from "vitest";
import {
  AttachmentValidationError,
  blocksToAgentHistoryText,
  decodeAttachmentBase64,
  inferAttachmentMimeType,
  promptTextForAttachments,
  userTurnBlocksForRun,
  validateAttachmentMimeType,
} from "./attachments.js";

describe("attachment helpers", () => {
  it("rejects unsupported mime types and empty payloads", () => {
    expect(() => validateAttachmentMimeType("application/zip")).toThrow(AttachmentValidationError);
    expect(() => decodeAttachmentBase64("")).toThrow(AttachmentValidationError);
  });

  it("builds prompt text and history summaries", () => {
    expect(
      promptTextForAttachments("caption", [
        { name: "notes.pdf", mimeType: "application/pdf", size: 42 },
      ]),
    ).toContain("notes.pdf");
    expect(
      blocksToAgentHistoryText([
        { kind: "text", text: "hello" },
        { kind: "image", artifactId: "a1", mimeType: "image/png", name: "shot.png" },
        {
          kind: "file",
          artifactId: "a2",
          mimeType: "application/pdf",
          name: "brief.pdf",
          size: 99,
        },
      ]),
    ).toBe("hello\n[image: shot.png]\n[file: brief.pdf (application/pdf, 99 bytes)]");
  });

  it("infers attachment mime types from extensions", () => {
    expect(inferAttachmentMimeType("photo.JPG", "")).toBe("image/jpeg");
    expect(inferAttachmentMimeType("notes.pdf", "")).toBe("application/pdf");
    expect(inferAttachmentMimeType("archive.zip", "")).toBeNull();
  });

  it("scopes current-turn images to user-triggered runs", () => {
    const messages = [
      {
        role: "user",
        runId: "run-old",
        blocks: [
          {
            kind: "image" as const,
            artifactId: "art_1",
            mimeType: "image/png",
            name: "old.png",
          },
        ],
      },
      {
        role: "user",
        runId: "run-new",
        blocks: [{ kind: "text" as const, text: "routine time" }],
      },
    ];
    expect(userTurnBlocksForRun("routine", "run-new", messages)).toBeUndefined();
    expect(userTurnBlocksForRun("user", "run-old", messages)).toEqual(messages[0]?.blocks);
    expect(userTurnBlocksForRun("user", "run-new", messages)).toEqual(messages[1]?.blocks);
  });
});
