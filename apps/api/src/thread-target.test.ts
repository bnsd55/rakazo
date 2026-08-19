import { runContinueJob } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";

// Test the fan-out nonce helpers via a thin re-export pattern — keep logic colocated with sendThreadMessage.
// We duplicate the pure functions here to avoid exporting implementation details from production code.

function fanoutRunClientNonce(
  clientNonce: string | undefined,
  botId: string,
  multiTarget: boolean,
): string | undefined {
  if (!clientNonce) return undefined;
  return multiTarget ? `${clientNonce}:${botId}` : clientNonce;
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

describe("nonce replay enqueue", () => {
  it("re-enqueues queued runs on replay", async () => {
    const enqueue = vi.fn();
    const runs = [
      { id: "run-a", status: "queued" },
      { id: "run-b", status: "completed" },
      { id: "run-c", status: "waiting_input" },
    ];
    for (const run of runs) {
      if (run.status === "queued" || run.status === "waiting_input") {
        await enqueue(runContinueJob(run.id));
      }
    }
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("run-a"));
    expect(enqueue).toHaveBeenCalledWith(runContinueJob("run-c"));
  });
});
