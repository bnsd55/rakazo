import type { AgentHomeStore, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import {
  type AdapterContext,
  computerControlExpireJobKey,
  skillTeachingExpireJobKey,
} from "@rakazo/adapter-kit";
import type { Actor, MessageBlock, TaughtSkill } from "@rakazo/contracts";
import {
  buildPlaybookFromRecording,
  type SkillPlaybook,
  type TeachRecordingEvent,
  type TeachSnapshot,
} from "@rakazo/core";
import {
  createThreadMessageInTransaction,
  IsolationError,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";
import { scheduleComputerSleep } from "./computer-idle.js";
import { toComputerRef } from "./computer-support.js";

export type TaughtSkillRow = {
  id: string;
  workspaceId: string;
  botId: string;
  userId: string;
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

export interface TeachingSessionDeps {
  prisma: PrismaClient;
  events: ThreadEvents;
  jobs: JobPublisher;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  dataDir: string;
}

export function emptyRecording(): TeachRecording {
  return { events: [], snapshots: [] };
}

export function parseRecording(value: unknown): TeachRecording {
  if (!value || typeof value !== "object") return emptyRecording();
  const record = value as Partial<TeachRecording>;
  return {
    events: Array.isArray(record.events) ? (record.events as TeachRecordingEvent[]) : [],
    snapshots: Array.isArray(record.snapshots) ? (record.snapshots as TeachSnapshot[]) : [],
  };
}

export function parsePlaybook(value: unknown): SkillPlaybook {
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

function recordingEventKey(event: TeachRecordingEvent): string {
  return JSON.stringify(event);
}

async function mutateRecording(
  deps: TeachingSessionDeps,
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
    if (skill.expiresAt && skill.expiresAt.getTime() <= Date.now()) {
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

export async function observeStopSnapshot(
  deps: TeachingSessionDeps,
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
  deps: TeachingSessionDeps,
  skillId: string,
  stopSnapshot?: TeachSnapshot,
): Promise<{ skill: TaughtSkillRow; didFinalize: boolean }> {
  return deps.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skillId} FOR UPDATE`;
    const skill = await tx.taughtSkill.findUniqueOrThrow({ where: { id: skillId } });
    if (skill.status === "draft" || skill.status === "saved") {
      return { skill, didFinalize: false };
    }
    if (skill.status !== "recording" && skill.status !== "drafting") {
      throw new Error("Teaching session is not active");
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
    const updated = await tx.taughtSkill.update({
      where: { id: skillId },
      data: {
        status: "draft",
        recording: recording as never,
        playbook: playbook as never,
        stoppedAt: new Date(),
      },
    });
    return { skill: updated, didFinalize: true };
  });
}

export async function appendRecordingEvent(
  deps: TeachingSessionDeps,
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

export async function releaseTeachingComputerControlForBot(
  deps: TeachingSessionDeps,
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
  deps: TeachingSessionDeps,
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

function skillDraftBlocks(skill: TaughtSkillRow): MessageBlock[] {
  return [
    {
      kind: "skill_draft",
      skillId: skill.id,
      name: skill.name || skill.goal.slice(0, 80),
      goal: skill.goal,
      playbook: parsePlaybook(skill.playbook),
      status: "draft",
    },
  ];
}

async function findSkillDraftMessage(
  prisma: { message: { findMany: PrismaClient["message"]["findMany"] } },
  threadId: string,
  skillId: string,
): Promise<{ id: string; blocks: MessageBlock[] } | null> {
  const messages = await prisma.message.findMany({
    where: { threadId, role: "bot" },
    orderBy: { seq: "desc" },
    take: 100,
    select: { id: true, blocks: true },
  });
  for (const message of messages) {
    const blocks = message.blocks as MessageBlock[];
    if (
      Array.isArray(blocks) &&
      blocks.some((block) => block.kind === "skill_draft" && block.skillId === skillId)
    ) {
      return { id: message.id, blocks };
    }
  }
  return null;
}

async function emitSkillDraftMessages(
  deps: TeachingSessionDeps,
  actor: Actor,
  skill: TaughtSkillRow,
  bot: { id: string; thread: { id: string } | null },
): Promise<void> {
  if (skill.status !== "draft" || !bot.thread) return;
  const threadId = bot.thread.id;
  const created = await deps.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${skill.id} FOR UPDATE`;
    const existing = await findSkillDraftMessage(tx, threadId, skill.id);
    if (existing) return existing;
    const blocks = skillDraftBlocks(skill);
    const message = await createThreadMessageInTransaction(tx, {
      threadId,
      role: "bot",
      blocks,
    });
    return { id: message.id, blocks };
  });
  await deps.events.append({
    workspaceId: actor.workspaceId,
    threadId,
    botId: bot.id,
    type: "thread.message.created",
    payload: { messageId: created.id, role: "bot", blocks: created.blocks },
  });
  await deps.events.append({
    workspaceId: actor.workspaceId,
    threadId,
    botId: bot.id,
    type: "skill.draft.created",
    payload: { skillId: skill.id, name: skill.name || skill.goal.slice(0, 80) },
  });
}

export async function completeTeachingSession(
  deps: TeachingSessionDeps,
  actor: Actor,
  skillId: string,
  reason: "stopped" | "expired",
  stopSnapshot?: TeachSnapshot,
): Promise<TaughtSkillRow> {
  const { skill: finalized, didFinalize } = await finalizeTeachingRecording(
    deps,
    skillId,
    stopSnapshot,
  );
  const bot = await deps.prisma.bot.findUnique({
    where: { id: finalized.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) throw new IsolationError();
  await releaseTeachingComputerControlForBot(deps, actor, bot.id);
  if (finalized.status === "draft") {
    await emitSkillDraftMessages(deps, actor, finalized, bot);
  }
  if (didFinalize && bot.thread) {
    await deps.events.append({
      workspaceId: actor.workspaceId,
      threadId: bot.thread.id,
      botId: bot.id,
      type: "skill.teaching.stopped",
      payload: { skillId: finalized.id, reason },
    });
  }
  return finalized;
}

export async function expireTaughtSkillTeaching(
  deps: TeachingSessionDeps,
  skillId: string,
): Promise<TaughtSkillRow | null> {
  const skill = await deps.prisma.taughtSkill.findUnique({ where: { id: skillId } });
  if (!skill) return null;
  const actor = { workspaceId: skill.workspaceId, userId: skill.userId } as Actor;
  if (skill.status !== "recording") {
    await releaseTeachingComputerControlForBot(deps, actor, skill.botId);
    if (skill.status === "draft") {
      const bot = await deps.prisma.bot.findUnique({
        where: { id: skill.botId },
        include: { thread: true },
      });
      if (bot) await emitSkillDraftMessages(deps, actor, skill, bot);
    }
    return skill;
  }
  if (!skill.expiresAt || skill.expiresAt.getTime() > Date.now()) {
    return skill;
  }
  const bot = await deps.prisma.bot.findUnique({
    where: { id: skill.botId },
    include: { thread: true, computer: true },
  });
  if (!bot) return skill;
  const stopSnapshot = bot.computer?.providerRef
    ? await observeStopSnapshot(deps, actor, bot)
    : undefined;
  const finalized = await completeTeachingSession(deps, actor, skill.id, "expired", stopSnapshot);
  await deps.jobs.cancel(skillTeachingExpireJobKey(skill.id));
  return finalized;
}

export async function recordTeachingInputEvent(
  deps: TeachingSessionDeps,
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
): Promise<"recorded" | "idle" | "stale"> {
  const skill = await getActiveTeachingSession(deps.prisma, actor.workspaceId, botId, actor.userId);
  if (!skill) return "idle";
  if (skill.expiresAt && skill.expiresAt.getTime() <= Date.now()) {
    await expireTaughtSkillTeaching(deps, skill.id);
    return "stale";
  }
  const updated = await appendRecordingEvent(deps, skill.id, {
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
  const appended =
    parseRecording(updated.recording).events.length > parseRecording(skill.recording).events.length;
  if (!appended && updated.expiresAt && updated.expiresAt.getTime() <= Date.now()) {
    await expireTaughtSkillTeaching(deps, updated.id);
    return "stale";
  }
  return updated.status === "recording" ? "recorded" : "stale";
}

export async function captureTeachingSnapshot(
  deps: TeachingSessionDeps,
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
