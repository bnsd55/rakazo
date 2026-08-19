import { describe, expect, it } from "vitest";
import { inferHandoffTargetBotId, resolveGroupTargetBotIds } from "./group-mentions.js";

const members = [
  { id: "a", name: "BotA" },
  { id: "b", name: "BotB" },
  { id: "c", name: "Writer" },
];

describe("resolveGroupTargetBotIds", () => {
  it("returns mentioned bots from text", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@BotA gather sources. @BotB summarize.",
        members,
      }),
    ).toEqual(["a", "b"]);
  });

  it("returns all members for @everyone", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "@everyone please review",
        members,
      }),
    ).toEqual(["a", "b", "c"]);
  });

  it("merges explicit mentions", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello",
        members,
        explicitMentions: ["b"],
      }),
    ).toEqual(["b"]);
  });

  it("picks the first member when unmentioned", () => {
    expect(
      resolveGroupTargetBotIds({
        text: "hello team",
        members,
      }),
    ).toEqual(["a"]);
  });
});

describe("inferHandoffTargetBotId", () => {
  it("recognizes hand this to Writer", () => {
    expect(inferHandoffTargetBotId("hand this to Writer for the draft", members)).toBe("c");
  });

  it("recognizes @Writer take the draft", () => {
    expect(inferHandoffTargetBotId("@Writer take the draft", members)).toBe("c");
  });
});
