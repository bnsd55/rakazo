import { describe, expect, it, vi } from "vitest";
import { ONCE_ROUTINE_CRON } from "@rakazo/core";
import {
  cancelScheduleFromTool,
  createScheduleFromTool,
  isOneShotRoutineCron,
  listSchedulesFromTool,
  resolveScheduleTiming,
} from "./schedule-tools.js";

describe("resolveScheduleTiming", () => {
  it("rejects repeating intervals under one minute", () => {
    expect(resolveScheduleTiming({ every: 2, unit: "seconds" })).toEqual({
      ok: false,
      error: "minimum interval is 1 minute",
    });
  });

  it("accepts every 1 minute", () => {
    const result = resolveScheduleTiming({ every: 1, unit: "minutes" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts cron every minute", () => {
    const result = resolveScheduleTiming({ cron: "*/1 * * * *" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe("*/1 * * * *");
    expect(result.oneShot).toBe(false);
  });

  it("creates one-shot schedules with @once cron", () => {
    const result = resolveScheduleTiming({ delayMinutes: 10 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.oneShot).toBe(true);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("allows sub-minute one-shot delays via delaySeconds", () => {
    const result = resolveScheduleTiming({ delaySeconds: 30 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cron).toBe(ONCE_ROUTINE_CRON);
    expect(result.nextRunAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.nextRunAt.getTime()).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it("rejects one-shot schedules in the past", () => {
    expect(
      resolveScheduleTiming({ runAt: new Date(Date.now() - 60_000).toISOString() }),
    ).toEqual({
      ok: false,
      error: "One-shot schedules must run in the future.",
    });
  });

  it("rejects mixing repeat and one-shot fields", () => {
    expect(resolveScheduleTiming({ cron: "0 9 * * *", delayMinutes: 5 })).toEqual({
      ok: false,
      error: "Provide either a repeating schedule or a one-shot time, not both.",
    });
  });
});

describe("isOneShotRoutineCron", () => {
  it("detects the one-shot sentinel", () => {
    expect(isOneShotRoutineCron(ONCE_ROUTINE_CRON)).toBe(true);
    expect(isOneShotRoutineCron("0 9 * * *")).toBe(false);
  });
});

describe("schedule tool persistence", () => {
  it("creates routines with routine.created and enqueues wakeup", async () => {
    const append = vi.fn(async () => undefined);
    const enqueue = vi.fn(async () => undefined);
    const create = vi.fn(async (args: { data: Record<string, unknown> }) => ({
      id: "routine-1",
      ...args.data,
      nextRunAt: args.data.nextRunAt,
    }));
    const deps = {
      prisma: { routine: { create } },
      events: { append },
      jobs: { enqueue, cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof createScheduleFromTool>[0];

    const result = await createScheduleFromTool(deps, {
      workspaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      threadId: "thread-1",
      name: "Morning joke",
      prompt: "Tell a joke",
      schedule: { every: 1, unit: "minutes" },
    });

    expect(result).toMatchObject({ ok: true, routineId: "routine-1", cron: "*/1 * * * *" });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          workspaceId: "ws-1",
          userId: "user-1",
          cron: "*/1 * * * *",
          active: true,
        }),
      }),
    );
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({ type: "routine.created", payload: { name: "Morning joke" } }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
  });

  it("scopes list and cancel to workspace and user", async () => {
    const findMany = vi.fn(async () => []);
    const findFirst = vi.fn(async () => null);
    const deps = {
      prisma: {
        routine: { findMany, findFirst, delete: vi.fn(async () => undefined) },
      },
      events: { append: vi.fn(async () => undefined) },
      jobs: { enqueue: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) },
    } as unknown as Parameters<typeof cancelScheduleFromTool>[0];

    await listSchedulesFromTool(deps, { workspaceId: "ws-1", botId: "bot-1", userId: "user-1" });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1", botId: "bot-1", userId: "user-1" },
      }),
    );

    const cancelled = await cancelScheduleFromTool(deps, {
      workspaceId: "ws-1",
      botId: "bot-1",
      userId: "user-1",
      routineId: "routine-1",
    });
    expect(cancelled).toEqual({ error: "Schedule not found." });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { workspaceId: "ws-1", botId: "bot-1", userId: "user-1", id: "routine-1" },
      }),
    );
  });
});
