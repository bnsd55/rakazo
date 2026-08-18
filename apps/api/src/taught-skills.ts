import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  type AdapterContext,
  runContinueJob,
  skillTeachingExpireJob,
  skillTeachingExpireJobKey,
} from "@rakazo/adapter-kit";
import {
  acquireComputerExecutionLease,
  hasActiveComputerControl,
  provisionComputer,
  releaseComputerExecutionLease,
  scheduleComputerControlExpiry,
  screenLeaseIdForRun,
  takeoverLeaseMs,
  toComputerRef,
} from "@rakazo/adapters";
import type { Actor, MessageBlock, TaughtSkill } from "@rakazo/contracts";
import {
  ACTIVE_RUN_STATUSES,
  buildPlaybookFromRecording,
  formatSkillRunPrompt,
  type SkillPlaybook,
  type TeachRecordingEvent,
  type TeachSnapshot,
  teachRecordingTtlMs,
} from "@rakazo/core";
import {
  createThreadMessage,
  IsolationError,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";

type TaughtSkillRow = {
  id: string;
  botId: string;
  name: string;
  goal: string;
  status: string;
  playbook: unknown;
  recording: unknown;
  startedAt: Date | null;
  expiresAt: Date | null;
  stoppedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type TeachRecording = {
  events: TeachRecordingEvent[];
  snapshots: TeachSnapshot[];
};

export interface TaughtSkillsDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  dataDir: string;
}

function emptyRecording(): TeachRecording {
  return { events: [], snapshots: [] };
}

function parseRecording(value: unknown): TeachRecording {
  if (!value || typeof value !== "object") return emptyRecording();
  const record = value as Partial<TeachRecording>;
  return {
    events: Array.isArray(record.events) ? (record.events as TeachRecordingEvent[]) : [],
    snapshots: Array.isArray(record.snapshots) ? (record.snapshots as TeachSnapshot[]) : [],
  };
}

function parsePlaybook(value: unknown): SkillPlaybook {
  if (!value || typeof value !== "object") {
    return buildPlaybookFromRecording("", []);
  }
  const record = value as Partial<SkillPlaybook>;
  return {
    whenToUse: String(record.whenToUse ?? ""),
    inputs: Array.isArray(record.inputs) ? record.inputs.map(String) : [],
    steps: Array.isArray(record.steps) ? record.steps.map(String) : [],
    howToCheck: String(record.howToCheck ?? ""),
    whatToReturn: String(record.whatToReturn ?? ""),
    approvalBoundaries: String(record.approvalBoundaries ?? ""),
    failureHandling: String(record.failureHandling ?? ""),
  };
}

export function mapTaughtSkill(row: TaughtSkillRow): TaughtSkill {
  return {
    id: row.id,
    botId: row.botId,
    name: row.name,
    goal: row.goal,
    status: row.status as TaughtSkill["status"],
    playbook: parsePlaybook(row.playbook),
    recording: parseRecording(row.recording),
    startedAt: row.startedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    stoppedAt: row.stoppedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function computerContext(actor: Actor, botId: string, operationId: string): AdapterContext {
  return {
    operationId,
    traceId: operationId,
    workspaceId: actor.workspaceId,
    userId: actor.userId,
    botId,
    signal: new AbortController().signal,
  };
}

export async function getActiveTeachingSession(
  prisma: PrismaClient,
  workspaceId: string,
  botId: string,
) {
  return prisma.taughtSkill.findFirst({
    where: { workspaceId, botId, status: "recording" },
  });
}

export async function assertTeachingSendAllowed(
  prisma: PrismaClient,
  workspaceId: string,
  botId: string,
): Promise<void> {
  const active = await getActiveTeachingSession(prisma, workspaceId, botId);
  if (active) {
    throw new ORPCError("CONFLICT", { message: "Stop teaching first" });
  }
}

async function cancelActiveRuns(deps: TaughtSkillsDeps, _actor: Actor, botId: string): Promise<void> {
  const activeRuns = await deps.prisma.run.findMany({
    where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    select: { id: true },
  });
  await deps.prisma.run.updateMany({
    where: { botId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    data: { status: "cancelled", completedAt: new Date() },
  });
  await deps.prisma.computerExecutionLease.deleteMany({ where: { botId } });
  await deps.prisma.computer.updateMany({
    where: { executionBotId: botId },
    data: { executionRunId: null, executionBotId: null, executionLeaseExpiresAt: null },
  });
  await deps.prisma.event.deleteMany({
    where: { type: "thread.progress", runId: { in: activeRuns.map((run) => run.id) } },
  });
}

async function ensureGraphicalComputer(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: Awaited<ReturnType<ReturnType<typeof import("@rakazo/db").createRepos>["getBot"]>>,
) {
  if (bot.computer?.kind === "desktop") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Teaching needs a graphical sandbox computer, not a desktop host",
    });
  }
  if (!bot.computer) throw new IsolationError();
  if (bot.computer.state !== "running" || !bot.computer.providerRef) {
    const ctx = computerContext(actor, bot.id, "skills.start");
    const manualRunId = `teach:${randomUUID()}`;
    const lease = await acquireComputerExecutionLease(deps.prisma, {
      computerId: bot.computer.id,
      runId: manualRunId,
      botId: bot.id,
    });
    try {
      await provisionComputer(deps, bot.computer.id, {
        ...ctx,
        screenLeaseId: screenLeaseIdForRun(lease, manualRunId),
      });
    } finally {
      await releaseComputerExecutionLease(deps.prisma, lease);
    }
    bot = await deps.prisma.bot.findUniqueOrThrow({
      where: { id: bot.id },
      include: { thread: true, computer: true },
    });
  }
  if (!bot.computer?.providerRef || bot.computer.state !== "running") {
    throw new ORPCError("BAD_REQUEST", { message: "Computer must be running to teach" });
  }
  if (bot.computer.kind === "desktop") {
    throw new ORPCError("BAD_REQUEST", {
      message: "Teaching needs a graphical sandbox computer, not a desktop host",
    });
  }
  return bot;
}

async function grantTakeover(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: Awaited<ReturnType<ReturnType<typeof import("@rakazo/db").createRepos>["getBot"]>>,
) {
  if (!bot.computer) throw new IsolationError();
  if (hasActiveComputerControl(bot.computer) && bot.computer.controlBotId === bot.id) {
    return bot;
  }
  const leaseId = randomUUID();
  const expiresAt = new Date(Date.now() + takeoverLeaseMs());
  const granted = await deps.prisma.computer.updateMany({
    where: {
      id: bot.computer.id,
      OR: [{ controlHolder: { not: "user" } }, { controlBotId: bot.id }],
    },
    data: {
      controlHolder: "user",
      controlLeaseId: leaseId,
      controlLeaseExpiresAt: expiresAt,
      controlBotId: bot.id,
      state: "running",
    },
  });
  if (granted.count !== 1) {
    throw new ORPCError("CONFLICT", { message: "Could not take control of the computer" });
  }
  await scheduleComputerControlExpiry(deps.jobs, bot.computer.id, leaseId, expiresAt);
  if (bot.thread) {
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "computer.takeover.granted",
      payload: { holder: "user", reason: "teaching" },
    });
  }
  return bot;
}

async function appendRecordingEvent(
  deps: TaughtSkillsDeps,
  skill: TaughtSkillRow,
  event: TeachRecordingEvent,
): Promise<TaughtSkillRow> {
  const recording = parseRecording(skill.recording);
  const last = recording.events.at(-1);
  if (
    last &&
    last.at === event.at &&
    last.kind === event.kind &&
    JSON.stringify(last) === JSON.stringify(event)
  ) {
    return skill;
  }
  recording.events.push(event);
  return deps.prisma.taughtSkill.update({
    where: { id: skill.id },
    data: { recording: recording as never },
  });
}

export async function recordTeachingInputEvent(
  deps: TaughtSkillsDeps,
  actor: Actor,
  botId: string,
  mapped:
    | { kind: "key"; key: string }
    | { kind: "clipboard"; text: string }
    | {
        kind: "pointer";
        x: number;
        y: number;
        button: "left" | "right";
        type: "move" | "down" | "up" | "click";
      },
): Promise<void> {
  const skill = await getActiveTeachingSession(deps.prisma, actor.workspaceId, botId);
  if (!skill) return;
  await appendRecordingEvent(deps, skill, {
    at: new Date().toISOString(),
    kind: mapped.kind,
    ...(mapped.kind === "key"
      ? { key: mapped.key }
      : mapped.kind === "clipboard"
        ? { text: mapped.text }
        : {
            x: mapped.x,
            y: mapped.y,
            button: mapped.button,
            type: mapped.type,
          }),
  });
}

async function captureSnapshot(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: { id: string; computer: { id: string; kind: string; providerRef: string | null } | null },
  skill: TaughtSkillRow,
): Promise<TaughtSkillRow> {
  if (!bot.computer?.providerRef) return skill;
  const observation = await deps.sandbox.observe(
    toComputerRef(bot.computer as never),
    computerContext(actor, bot.id, "skills.snapshot"),
  );
  const summary =
    typeof observation === "object" &&
    observation &&
    "activeWindow" in observation &&
    observation.activeWindow &&
    typeof observation.activeWindow === "object" &&
    "title" in observation.activeWindow
      ? String((observation.activeWindow as { title?: string }).title ?? "screen captured")
      : "screen captured";
  const recording = parseRecording(recordingSafe(skill));
  const snapshot: TeachSnapshot = { at: new Date().toISOString(), summary };
  recording.snapshots.push(snapshot);
  recording.events.push({ at: snapshot.at, kind: "snapshot", summary });
  return deps.prisma.taughtSkill.update({
    where: { id: skill.id },
    data: { recording: recording as never },
  });
}

function recordingSafe(skill: TaughtSkillRow): TeachRecording {
  return parseRecording(skill.recording);
}

async function finalizeDraft(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skill: TaughtSkillRow,
  bot: { id: string; thread: { id: string } | null },
): Promise<TaughtSkillRow> {
  const recording = recordingSafe(skill);
  const playbook = buildPlaybookFromRecording(skill.goal, recording.events, recording.snapshots);
  const updated = await deps.prisma.taughtSkill.update({
    where: { id: skill.id },
    data: {
      status: "draft",
      playbook: playbook as never,
      stoppedAt: new Date(),
    },
  });
  if (bot.thread) {
    const blocks: MessageBlock[] = [
      {
        kind: "skill_draft",
        skillId: updated.id,
        name: updated.name || skill.goal.slice(0, 80),
        goal: updated.goal,
        playbook,
        status: "draft",
      },
    ];
    const message = await createThreadMessage(deps.prisma, {
      threadId: bot.thread.id,
      role: "bot",
      blocks,
    });
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "thread.message.created",
      payload: { messageId: message.id, role: "bot", blocks },
    });
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "skill.draft.created",
      payload: { skillId: updated.id, name: updated.name || skill.goal.slice(0, 80) },
    });
  }
  return updated;
}

export async function expireTeachingSessionIfNeeded(
  deps: TaughtSkillsDeps,
  skillId: string,
): Promise<TaughtSkillRow | null> {
  const skill = await deps.prisma.taughtSkill.findUnique({ where: { id: skillId } });
  if (skill?.status !== "recording") return skill ?? null;
  if (!skill.expiresAt || skill.expiresAt.getTime() > Date.now()) {
    if (skill.expiresAt) {
      await deps.jobs.enqueue(skillTeachingExpireJob(skill.id, skill.expiresAt));
    }
    return skill;
  }
  await deps.jobs.cancel(skillTeachingExpireJobKey(skill.id));
  const bot = await deps.prisma.bot.findUnique({
    where: { id: skill.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) return skill;
  const actor = { workspaceId: skill.workspaceId, userId: skill.userId } as Actor;
  await deps.prisma.taughtSkill.update({
    where: { id: skill.id },
    data: { status: "drafting" },
  });
  const finalized = await finalizeDraft(deps, actor, skill, bot);
  if (bot.thread) {
    await deps.events.append({
      workspaceId: skill.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "skill.teaching.stopped",
      payload: { skillId: skill.id, reason: "expired" },
    });
  }
  return finalized;
}

export async function stopTeachingSession(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skillId: string,
): Promise<TaughtSkill> {
  const skill = await deps.prisma.taughtSkill.findFirst({
    where: { id: skillId, workspaceId: actor.workspaceId },
  });
  if (!skill) throw new IsolationError();
  await expireTeachingSessionIfNeeded(deps, skill.id);
  const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
  if (current.status === "draft" || current.status === "saved") {
    return mapTaughtSkill(current);
  }
  if (current.status !== "recording" && current.status !== "drafting") {
    throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not active" });
  }
  await deps.jobs.cancel(skillTeachingExpireJobKey(skill.id));
  const bot = await deps.prisma.bot.findUnique({
    where: { id: current.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  await deps.prisma.taughtSkill.update({
    where: { id: current.id },
    data: { status: "drafting" },
  });
  const finalized = await finalizeDraft(deps, actor, current, bot);
  if (bot.thread) {
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "skill.teaching.stopped",
      payload: { skillId: current.id, reason: "stopped" },
    });
  }
  return mapTaughtSkill(finalized);
}

export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  return {
    async list(actor: Actor, botId: string): Promise<TaughtSkill[]> {
      const rows = await deps.prisma.taughtSkill.findMany({
        where: { workspaceId: actor.workspaceId, botId },
        orderBy: { updatedAt: "desc" },
      });
      return rows.map(mapTaughtSkill);
    },

    async get(actor: Actor, skillId: string): Promise<TaughtSkill> {
      const row = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId },
      });
      if (!row) throw new IsolationError();
      await expireTeachingSessionIfNeeded(deps, row.id);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      return mapTaughtSkill(current);
    },

    async start(actor: Actor, botId: string, goal: string): Promise<TaughtSkill> {
      const existing = await getActiveTeachingSession(deps.prisma, actor.workspaceId, botId);
      if (existing) {
        throw new ORPCError("CONFLICT", { message: "A teaching session is already active" });
      }
      let bot = await deps.prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId, userId: actor.userId },
        include: { thread: true, computer: true },
      });
      if (!bot) throw new IsolationError();
      await cancelActiveRuns(deps, actor, botId);
      bot = await ensureGraphicalComputer(deps, actor, bot);
      await grantTakeover(deps, actor, bot);
      const startedAt = new Date();
      const expiresAt = new Date(startedAt.getTime() + teachRecordingTtlMs());
      const row = await deps.prisma.taughtSkill.create({
        data: {
          workspaceId: actor.workspaceId,
          botId,
          userId: actor.userId,
          goal,
          status: "recording",
          startedAt,
          expiresAt,
          recording: emptyRecording() as never,
          playbook: buildPlaybookFromRecording(goal, []) as never,
        },
      });
      await deps.jobs.enqueue(skillTeachingExpireJob(row.id, expiresAt));
      const withSnapshot = await captureSnapshot(deps, actor, bot, row);
      if (bot.thread) {
        await deps.events.append({
          workspaceId: actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "skill.teaching.started",
          payload: { skillId: row.id, goal },
        });
      }
      return mapTaughtSkill(withSnapshot);
    },

    async appendEvent(
      actor: Actor,
      skillId: string,
      event: TeachRecordingEvent,
    ): Promise<TaughtSkill> {
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId },
      });
      if (!skill) throw new IsolationError();
      await expireTeachingSessionIfNeeded(deps, skill.id);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      if (current.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      const updated = await appendRecordingEvent(deps, current, event);
      return mapTaughtSkill(updated);
    },

    async snapshot(actor: Actor, skillId: string): Promise<TaughtSkill> {
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId },
      });
      if (!skill) throw new IsolationError();
      await expireTeachingSessionIfNeeded(deps, skill.id);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      if (current.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      const bot = await deps.prisma.bot.findUnique({
        where: { id: current.botId },
        include: { computer: true },
      });
      if (!bot) throw new IsolationError();
      const updated = await captureSnapshot(deps, actor, bot, current);
      return mapTaughtSkill(updated);
    },

    stop: (actor: Actor, skillId: string) => stopTeachingSession(deps, actor, skillId),

    async updateDraft(
      actor: Actor,
      skillId: string,
      input: { name?: string; playbook: SkillPlaybook },
    ): Promise<TaughtSkill> {
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId, userId: actor.userId },
      });
      if (!skill) throw new IsolationError();
      if (skill.status !== "draft" && skill.status !== "saved") {
        throw new ORPCError("BAD_REQUEST", { message: "Skill is not editable yet" });
      }
      const row = await deps.prisma.taughtSkill.update({
        where: { id: skill.id },
        data: {
          name: input.name ?? skill.name,
          playbook: input.playbook as never,
          status: skill.status === "saved" ? "saved" : "draft",
        },
      });
      return mapTaughtSkill(row);
    },

    async save(actor: Actor, skillId: string, name?: string): Promise<TaughtSkill> {
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId, userId: actor.userId },
      });
      if (!skill) throw new IsolationError();
      if (skill.status !== "draft" && skill.status !== "saved") {
        throw new ORPCError("BAD_REQUEST", { message: "Save the draft before saving" });
      }
      const row = await deps.prisma.taughtSkill.update({
        where: { id: skill.id },
        data: {
          status: "saved",
          name: name ?? (skill.name || skill.goal.slice(0, 80)),
        },
      });
      const bot = await deps.prisma.bot.findUnique({
        where: { id: row.botId },
        include: { thread: true },
      });
      if (bot?.thread) {
        await deps.events.append({
          workspaceId: actor.workspaceId,
          threadId: bot.thread.id,
          botId: bot.id,
          type: "skill.saved",
          payload: { skillId: row.id, name: row.name },
        });
      }
      return mapTaughtSkill(row);
    },

    async testRun(actor: Actor, skillId: string, prompt?: string): Promise<{ runId: string }> {
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId },
      });
      if (!skill) throw new IsolationError();
      if (skill.status !== "saved" && skill.status !== "draft") {
        throw new ORPCError("BAD_REQUEST", { message: "Skill must be saved or drafted first" });
      }
      const bot = await deps.prisma.bot.findUnique({
        where: { id: skill.botId },
        include: { thread: true },
      });
      if (!bot?.thread) throw new IsolationError();
      const playbook = parsePlaybook(skill.playbook);
      const taskPrompt =
        prompt ?? formatSkillRunPrompt(skill.name || skill.goal.slice(0, 80), playbook, true);
      const task = await deps.prisma.task.create({
        data: {
          workspaceId: actor.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          userId: actor.userId,
          prompt: taskPrompt,
          status: "queued",
        },
      });
      const run = await deps.prisma.run.create({
        data: {
          workspaceId: actor.workspaceId,
          botId: bot.id,
          threadId: bot.thread.id,
          taskId: task.id,
          userId: actor.userId,
          status: "queued",
          trigger: "skill",
        },
      });
      await deps.jobs.enqueue(runContinueJob(run.id));
      return { runId: run.id };
    },

    async remove(actor: Actor, skillId: string): Promise<{ ok: true }> {
      const skill = await deps.prisma.taughtSkill.findFirst({
        where: { id: skillId, workspaceId: actor.workspaceId },
      });
      if (!skill) throw new IsolationError();
      if (skill.status === "recording") {
        await deps.jobs.cancel(skillTeachingExpireJobKey(skill.id));
      }
      await deps.prisma.taughtSkill.delete({ where: { id: skill.id } });
      return { ok: true as const };
    },

    expireTeachingSessionIfNeeded: (skillId: string) =>
      expireTeachingSessionIfNeeded(deps, skillId),

    async recordInput(
      actor: Actor,
      botId: string,
      mapped:
        | { kind: "key"; key: string }
        | { kind: "clipboard"; text: string }
        | {
            kind: "pointer";
            x: number;
            y: number;
            button: "left" | "right";
            type: "move" | "down" | "up" | "click";
          },
    ): Promise<void> {
      await recordTeachingInputEvent(deps, actor, botId, mapped);
    },
  };
}
