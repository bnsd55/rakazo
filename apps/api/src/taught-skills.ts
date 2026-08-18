import { randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  type AdapterContext,
  computerControlExpireJobKey,
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
  scheduleComputerSleep,
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

function ownedSkillWhere(actor: Actor, skillId: string) {
  return { id: skillId, workspaceId: actor.workspaceId, userId: actor.userId };
}

async function getOwnedSkill(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skillId: string,
): Promise<TaughtSkillRow> {
  const skill = await deps.prisma.taughtSkill.findFirst({ where: ownedSkillWhere(actor, skillId) });
  if (!skill) throw new IsolationError();
  return skill;
}

export async function getActiveTeachingSession(
  prisma: PrismaClient,
  workspaceId: string,
  botId: string,
  userId?: string,
) {
  return prisma.taughtSkill.findFirst({
    where: {
      workspaceId,
      botId,
      status: "recording",
      ...(userId ? { userId } : {}),
    },
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

async function cancelActiveRuns(
  deps: TaughtSkillsDeps,
  _actor: Actor,
  botId: string,
): Promise<void> {
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

function recordingEventKey(event: TeachRecordingEvent): string {
  const { at: _at, ...rest } = event;
  return JSON.stringify(rest);
}

async function mutateRecording(
  deps: TaughtSkillsDeps,
  skillId: string,
  mutate: (recording: TeachRecording) => { recording: TeachRecording; changed: boolean },
  options?: { requireRecording?: boolean },
): Promise<TaughtSkillRow> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skillId} FOR UPDATE`;
    const skill = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
    if (options?.requireRecording !== false && skill.status !== "recording") {
      return skill;
    }
    const current = parseRecording(skill.recording);
    const next = mutate(current);
    if (!next.changed) return skill;
    return tx.taughtSkill.update({
      where: { id: skillId },
      data: { recording: next.recording as never },
    });
  });
}

async function observeStopSnapshot(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: { id: string; computer: { providerRef: string | null } | null },
): Promise<TeachSnapshot | undefined> {
  if (!bot.computer?.providerRef) return undefined;
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
  return { at: new Date().toISOString(), summary };
}

async function finalizeTeachingRecording(
  deps: TaughtSkillsDeps,
  skillId: string,
  stopSnapshot?: TeachSnapshot,
): Promise<TaughtSkillRow> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skillId} FOR UPDATE`;
    const skill = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
    if (skill.status === "draft" || skill.status === "saved") return skill;
    if (skill.status !== "recording" && skill.status !== "drafting") {
      throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not active" });
    }
    const recording = parseRecording(skill.recording);
    if (stopSnapshot) {
      recording.snapshots.push(stopSnapshot);
      recording.events.push({
        at: stopSnapshot.at,
        kind: "snapshot",
        summary: stopSnapshot.summary,
      });
    }
    const playbook = buildPlaybookFromRecording(skill.goal, recording.events, recording.snapshots);
    return tx.taughtSkill.update({
      where: { id: skillId },
      data: {
        status: "draft",
        recording: recording as never,
        playbook: playbook as never,
        stoppedAt: new Date(),
      },
    });
  });
}

async function appendRecordingEvent(
  deps: TaughtSkillsDeps,
  skillId: string,
  event: TeachRecordingEvent,
  options?: { requireRecording?: boolean },
): Promise<TaughtSkillRow> {
  return mutateRecording(
    deps,
    skillId,
    (recording) => {
      const key = recordingEventKey(event);
      if (recording.events.some((existing) => recordingEventKey(existing) === key)) {
        return { recording, changed: false };
      }
      recording.events.push(event);
      return { recording, changed: true };
    },
    options,
  );
}

async function releaseTeachingComputerControlForBot(
  deps: TaughtSkillsDeps,
  actor: Actor,
  botId: string,
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    include: { computer: true },
  });
  if (!bot) return;
  await releaseTeachingComputerControl(deps, actor, bot);
}

async function releaseTeachingComputerControl(
  deps: TaughtSkillsDeps,
  actor: Actor,
  bot: {
    id: string;
    computer: {
      id: string;
      providerRef: string | null;
      controlHolder: string;
      controlBotId: string | null;
      controlLeaseId: string | null;
    } | null;
  },
): Promise<void> {
  const computer = bot.computer;
  if (
    computer?.controlHolder !== "user" ||
    computer.controlBotId !== bot.id ||
    !computer.controlLeaseId
  ) {
    return;
  }
  const leaseId = computer.controlLeaseId;
  if (computer.providerRef) {
    await deps.sandbox.setScreenControl?.(
      toComputerRef(computer as never),
      false,
      computerContext(actor, bot.id, "skills.release"),
      leaseId,
    );
  }
  await deps.jobs.cancel(computerControlExpireJobKey(computer.id));
  await deps.events.finalizeComputerControlRelease({
    workspaceId: actor.workspaceId,
    computerId: computer.id,
    botId: bot.id,
    leaseId,
    holder: "bot",
    reason: "released",
  });
  await scheduleComputerSleep(deps.jobs, computer.id);
}

async function updateSkillDraftMessage(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skill: TaughtSkillRow,
  input: {
    name?: string;
    playbook?: SkillPlaybook;
    status?: "draft" | "saved";
  },
): Promise<void> {
  const bot = await deps.prisma.bot.findUnique({
    where: { id: skill.botId },
    include: { thread: true },
  });
  if (!bot?.thread) return;

  const messages = await deps.prisma.message.findMany({
    where: { threadId: bot.thread.id, role: "bot" },
    orderBy: { seq: "desc" },
    take: 100,
  });

  for (const message of messages) {
    const parsed = message.blocks as MessageBlock[];
    if (!Array.isArray(parsed)) continue;
    const index = parsed.findIndex(
      (block) => block.kind === "skill_draft" && block.skillId === skill.id,
    );
    if (index === -1) continue;
    const existing = parsed[index];
    if (existing?.kind !== "skill_draft") continue;
    const playbook = input.playbook ?? parsePlaybook(skill.playbook);
    const nextBlocks: MessageBlock[] = [...parsed];
    nextBlocks[index] = {
      kind: "skill_draft",
      skillId: skill.id,
      name: input.name ?? existing.name,
      goal: skill.goal,
      playbook,
      status: input.status ?? existing.status,
    };
    await deps.prisma.message.update({
      where: { id: message.id },
      data: { blocks: nextBlocks as never },
    });
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "thread.message.updated",
      payload: { messageId: message.id, role: "bot", blocks: nextBlocks },
    });
    return;
  }
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
  const skill = await getActiveTeachingSession(deps.prisma, actor.workspaceId, botId, actor.userId);
  if (!skill) return;
  await appendRecordingEvent(deps, skill.id, {
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
  const snapshot = await observeStopSnapshot(deps, actor, bot);
  if (!snapshot) return skill;
  return mutateRecording(deps, skill.id, (recording) => {
    recording.snapshots.push(snapshot);
    recording.events.push({ at: snapshot.at, kind: "snapshot", summary: snapshot.summary });
    return { recording, changed: true };
  });
}

async function emitSkillDraftMessages(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skill: TaughtSkillRow,
  bot: { id: string; thread: { id: string } | null },
): Promise<void> {
  if (skill.status !== "draft" || !bot.thread) return;
  const playbook = parsePlaybook(skill.playbook);
  const blocks: MessageBlock[] = [
    {
      kind: "skill_draft",
      skillId: skill.id,
      name: skill.name || skill.goal.slice(0, 80),
      goal: skill.goal,
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
    payload: { skillId: skill.id, name: skill.name || skill.goal.slice(0, 80) },
  });
}

async function completeTeachingSession(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skillId: string,
  reason: "stopped" | "expired",
  stopSnapshot?: TeachSnapshot,
): Promise<TaughtSkillRow> {
  const before = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
  const finalized = await finalizeTeachingRecording(deps, skillId, stopSnapshot);
  const bot = await deps.prisma.bot.findUnique({
    where: { id: finalized.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  if (before.status !== "draft" && before.status !== "saved" && finalized.status === "draft") {
    await emitSkillDraftMessages(deps, actor, finalized, bot);
    if (bot.thread) {
      await deps.events.append({
        workspaceId: actor.workspaceId,
        threadId: bot.thread.id,
        botId: bot.id,
        type: "skill.teaching.stopped",
        payload: { skillId: finalized.id, reason },
      });
    }
  }
  await releaseTeachingComputerControlForBot(deps, actor, bot.id);
  return finalized;
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
  const stopSnapshot = bot.computer?.providerRef
    ? await observeStopSnapshot(deps, actor, bot)
    : undefined;
  return completeTeachingSession(deps, actor, skill.id, "expired", stopSnapshot);
}

export async function stopTeachingSession(
  deps: TaughtSkillsDeps,
  actor: Actor,
  skillId: string,
): Promise<TaughtSkill> {
  await getOwnedSkill(deps, actor, skillId);
  await expireTeachingSessionIfNeeded(deps, skillId);
  const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
  if (current.status === "draft" || current.status === "saved") {
    await releaseTeachingComputerControlForBot(deps, actor, current.botId);
    return mapTaughtSkill(current);
  }
  if (current.status !== "recording" && current.status !== "drafting") {
    throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not active" });
  }
  await deps.jobs.cancel(skillTeachingExpireJobKey(current.id));
  const bot = await deps.prisma.bot.findUnique({
    where: { id: current.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  const stopSnapshot =
    current.status === "recording" && bot.computer?.providerRef
      ? await observeStopSnapshot(deps, actor, bot)
      : undefined;
  const finalized = await completeTeachingSession(deps, actor, skillId, "stopped", stopSnapshot);
  return mapTaughtSkill(finalized);
}

export function createTaughtSkillsService(deps: TaughtSkillsDeps) {
  return {
    async list(actor: Actor, botId: string): Promise<TaughtSkill[]> {
      const rows = await deps.prisma.taughtSkill.findMany({
        where: { workspaceId: actor.workspaceId, botId, userId: actor.userId },
        orderBy: { updatedAt: "desc" },
      });
      return rows.map(mapTaughtSkill);
    },

    async get(actor: Actor, skillId: string): Promise<TaughtSkill> {
      const row = await getOwnedSkill(deps, actor, skillId);
      await expireTeachingSessionIfNeeded(deps, row.id);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      return mapTaughtSkill(current);
    },

    async start(actor: Actor, botId: string, goal: string): Promise<TaughtSkill> {
      const existing = await getActiveTeachingSession(
        deps.prisma,
        actor.workspaceId,
        botId,
        actor.userId,
      );
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
      await getOwnedSkill(deps, actor, skillId);
      await expireTeachingSessionIfNeeded(deps, skillId);
      const current = await deps.prisma.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
      if (current.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      const updated = await appendRecordingEvent(deps, skillId, event, { requireRecording: true });
      if (updated.status !== "recording") {
        throw new ORPCError("BAD_REQUEST", { message: "Teaching session is not recording" });
      }
      return mapTaughtSkill(updated);
    },

    async snapshot(actor: Actor, skillId: string): Promise<TaughtSkill> {
      await getOwnedSkill(deps, actor, skillId);
      await expireTeachingSessionIfNeeded(deps, skillId);
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
      const skill = await getOwnedSkill(deps, actor, skillId);
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
      await updateSkillDraftMessage(deps, actor, row, {
        name: row.name,
        playbook: parsePlaybook(row.playbook),
        status: row.status === "saved" ? "saved" : "draft",
      });
      return mapTaughtSkill(row);
    },

    async save(actor: Actor, skillId: string, name?: string): Promise<TaughtSkill> {
      const skill = await getOwnedSkill(deps, actor, skillId);
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
      await updateSkillDraftMessage(deps, actor, row, {
        name: row.name,
        playbook: parsePlaybook(row.playbook),
        status: "saved",
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
      const skill = await getOwnedSkill(deps, actor, skillId);
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
      const skill = await getOwnedSkill(deps, actor, skillId);
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
