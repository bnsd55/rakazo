import { mkdir } from "node:fs/promises";
import type {
  AdapterContext,
  AgentHomeStore,
  ComputerRef,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { type PrismaClient, parseComputerMode, type ThreadEvents } from "@rakazo/db";
import { expireComputerControl, hasActiveComputerControl } from "./computer-control.js";
import { ensureComputerWorkspaceLayout, restoreComputerWorkspace } from "./computer-workspace.js";
import { resolveAgentHomePath } from "./home.js";

const EXECUTION_LEASE_MS = 5 * 60_000;
const BOOT_WAIT_ATTEMPTS = 40;
const BOOT_WAIT_MS = 250;

export class ComputerBusyError extends Error {
  constructor() {
    super("Computer is busy");
    this.name = "ComputerBusyError";
  }
}

export { toComputerRef } from "./computer-support.js";

export async function provisionComputer(
  deps: {
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    jobs: JobPublisher;
    events: ThreadEvents;
    dataDir?: string;
  },
  computerId: string,
  context: AdapterContext,
  controlHolder: "bot" | "none" = "none",
): Promise<ComputerRef> {
  let existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
    await expireComputerControl(deps, existing.id, existing.controlLeaseId);
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (existing.controlLeaseId && !hasActiveComputerControl(existing)) {
      throw new Error("computer control revocation is still in progress");
    }
  }
  const homePath = resolveAgentHomePath(deps.home, existing.homeKey, deps.dataDir ?? "./data");
  await mkdir(homePath, { recursive: true });

  if (existing.state === "running" && existing.providerRef) {
    return reconnectComputer(deps, existing, homePath, context);
  }
  if (existing.state === "booting" || existing.state === "suspending") {
    const ready = await waitForComputerReady(deps.prisma, computerId, context);
    if (ready?.state === "running" && ready.providerRef) {
      return reconnectComputer(deps, ready, homePath, context);
    }
    existing = await deps.prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
  }

  const claimed = await deps.prisma.computer.updateMany({
    where: {
      id: computerId,
      state: { in: ["stopped", "suspended", "error"] },
      ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
    },
    data: { state: "booting" },
  });
  if (claimed.count !== 1) throw new ComputerBusyError();
  let provisioned: ComputerRef | undefined;
  try {
    const ref = await deps.sandbox.provision(
      {
        botId: existing.homeKey,
        homePath,
        providerRef: existing.providerRef ?? undefined,
        providerKind: existing.kind as ComputerRef["kind"],
      },
      context,
    );
    provisioned = ref;
    const replacement =
      ref.fresh === true ||
      !existing.providerRef ||
      existing.providerRef !== ref.providerRef ||
      existing.kind !== ref.kind;
    if (replacement) {
      await restoreComputerWorkspace(deps.home, deps.sandbox, existing.homeKey, ref, context);
    }
    await ensureComputerWorkspaceLayout(
      deps.sandbox,
      ref,
      parseComputerMode(existing.scope),
      context.botId,
      context,
    );
    const activeControl = hasActiveComputerControl(existing);
    const activated = await deps.prisma.computer.updateMany({
      where: {
        id: computerId,
        state: "booting",
        ...(context.botId ? { bots: { some: { id: context.botId, archivedAt: null } } } : {}),
      },
      data: {
        state: "running",
        providerRef: ref.providerRef,
        kind: ref.kind,
        controlHolder: activeControl ? "user" : controlHolder,
        ...(!activeControl
          ? { controlLeaseId: null, controlLeaseExpiresAt: null, controlBotId: null }
          : {}),
      },
    });
    if (activated.count !== 1) {
      await deps.sandbox.stop(ref, context).catch(() => deps.sandbox.destroy(ref, context));
      throw new ComputerBusyError();
    }
    return ref;
  } catch (error) {
    if (provisioned?.fresh) await deps.sandbox.destroy(provisioned, context).catch(() => undefined);
    await deps.prisma.computer.updateMany({
      where: { id: computerId, state: "booting" },
      data: { state: "error" },
    });
    throw error;
  }
}

async function reconnectComputer(
  deps: {
    sandbox: SandboxProvider;
    home: AgentHomeStore;
    dataDir?: string;
  },
  computer: {
    homeKey: string;
    providerRef: string | null;
    kind: string;
    scope: string;
  },
  homePath: string,
  context: AdapterContext,
): Promise<ComputerRef> {
  const ref = await deps.sandbox.provision(
    {
      botId: computer.homeKey,
      homePath,
      providerRef: computer.providerRef ?? undefined,
      providerKind: computer.kind as ComputerRef["kind"],
    },
    context,
  );
  await ensureComputerWorkspaceLayout(
    deps.sandbox,
    ref,
    parseComputerMode(computer.scope),
    context.botId,
    context,
  );
  return ref;
}

async function waitForComputerReady(
  prisma: PrismaClient,
  computerId: string,
  context: AdapterContext,
) {
  for (let attempt = 0; attempt < BOOT_WAIT_ATTEMPTS; attempt += 1) {
    const current = await prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
    if (current.state === "running" && current.providerRef) return current;
    if (current.state !== "booting" && current.state !== "suspending") return current;
    await new Promise((resolve) => setTimeout(resolve, BOOT_WAIT_MS));
    if (context.signal.aborted) {
      throw context.signal.reason ?? new Error("computer boot aborted");
    }
  }
  return prisma.computer.findUniqueOrThrow({ where: { id: computerId } });
}

export interface ComputerExecutionLease {
  computerId: string;
  botId: string;
  runId: string;
  fence: number;
}

export async function acquireComputerExecutionLease(
  prisma: PrismaClient,
  input: {
    computerId: string;
    runId: string;
    botId: string;
    resumeHeldLease?: boolean;
  },
): Promise<ComputerExecutionLease | null> {
  const computer = await prisma.computer.findUniqueOrThrow({ where: { id: input.computerId } });
  if (computer.scope !== "team") return null;
  if (computer.state === "suspending") throw new ComputerBusyError();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + EXECUTION_LEASE_MS);
  const [reclaimed] = await prisma.computerExecutionLease.updateManyAndReturn({
    where: {
      computerId: input.computerId,
      botId: input.botId,
      OR: [{ expiresAt: { lt: now } }, ...(input.resumeHeldLease ? [{ runId: input.runId }] : [])],
    },
    data: {
      runId: input.runId,
      expiresAt,
      fence: { increment: 1 },
    },
    select: { fence: true },
  });
  if (reclaimed) {
    return {
      computerId: input.computerId,
      botId: input.botId,
      runId: input.runId,
      fence: reclaimed.fence,
    };
  }
  try {
    const created = await prisma.computerExecutionLease.create({
      data: {
        computerId: input.computerId,
        botId: input.botId,
        runId: input.runId,
        fence: 1,
        expiresAt,
      },
      select: { fence: true },
    });
    return {
      computerId: input.computerId,
      botId: input.botId,
      runId: input.runId,
      fence: created.fence,
    };
  } catch (error) {
    if (isUniqueConstraintError(error)) throw new ComputerBusyError();
    throw error;
  }
}

export async function renewComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const renewed = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
    },
    data: { expiresAt: new Date(Date.now() + EXECUTION_LEASE_MS) },
  });
  return renewed.count === 1;
}

export async function holdComputerExecutionLeaseForTakeover(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<boolean> {
  if (!lease) return true;
  const held = await prisma.computerExecutionLease.updateMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
    },
    data: { expiresAt: new Date(Date.now() + 24 * 60 * 60_000) },
  });
  return held.count === 1;
}

export async function releaseComputerExecutionLease(
  prisma: PrismaClient,
  lease: ComputerExecutionLease | null,
): Promise<void> {
  if (!lease) return;
  await prisma.computerExecutionLease.deleteMany({
    where: {
      computerId: lease.computerId,
      botId: lease.botId,
      runId: lease.runId,
      fence: lease.fence,
    },
  });
}

function isUniqueConstraintError(error: unknown) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}
