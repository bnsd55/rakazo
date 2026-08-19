import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";

function fanoutRunClientNonce(
  clientNonce: string | undefined,
  botId: string,
  multiTarget: boolean,
): string | undefined {
  if (!clientNonce) return undefined;
  return multiTarget ? `${clientNonce}:${botId}` : clientNonce;
}

function sendNonceKeys(clientNonce: string, targetBotIds: string[]): string[] {
  if (targetBotIds.length <= 1) return [clientNonce];
  return targetBotIds.map((botId) => `${clientNonce}:${botId}`);
}

describe("fanoutRunClientNonce", () => {
  it("uses the request nonce for a single target", () => {
    expect(fanoutRunClientNonce("nonce-1", "bot-a", false)).toBe("nonce-1");
  });

  it("derives per-bot keys for multi-target fan-out", () => {
    expect(fanoutRunClientNonce("nonce-1", "bot-a", true)).toBe("nonce-1:bot-a");
    expect(fanoutRunClientNonce("nonce-1", "bot-b", true)).toBe("nonce-1:bot-b");
  });
});

describe("sendNonceKeys", () => {
  it("uses the raw nonce for a single target", () => {
    expect(sendNonceKeys("nonce-1", ["bot-a"])).toEqual(["nonce-1"]);
  });

  it("derives exact per-bot keys for multi-target fan-out", () => {
    expect(sendNonceKeys("nonce-1", ["bot-a", "bot-b"])).toEqual(["nonce-1:bot-a", "nonce-1:bot-b"]);
  });
});

describe("nonce replay enqueue", () => {
  it("re-enqueues only queued runs on replay", async () => {
    const enqueue = vi.fn();
    const runs = [
      { id: "run-a", status: "queued" },
      { id: "run-b", status: "completed" },
      { id: "run-c", status: "waiting_input" },
    ];
    for (const run of runs) {
      if (run.status === "queued") {
        await enqueue(runContinueJob(run.id));
      }
    }
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("run-a"));
  });
});
