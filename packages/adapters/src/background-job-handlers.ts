import type {
  AgentHomeStore,
  BackgroundJobHandlers,
  JobPublisher,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { expireComputerControl } from "./computer-control.js";
import { scheduleComputerSleep, sleepComputerIfIdle } from "./computer-idle.js";
import type { createRunExecutor } from "./executor.js";
import { expireTaughtSkillTeaching } from "./teaching-session.js";

export function createBackgroundJobHandlers(deps: {
  executor: ReturnType<typeof createRunExecutor>;
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  jobs: JobPublisher;
  events: ThreadEvents;
  workerId: string;
  dataDir: string;
  onSkillTeachingExpire?: (skillId: string) => Promise<void>;
}): BackgroundJobHandlers {
  return {
    "run.continue": async (payload) => {
      await deps.executor.continueRun(payload.runId, deps.workerId);
    },
    "routine.wakeup": async (payload) => {
      await deps.executor.wakeRoutine(payload.routineId, payload.scheduledFor);
    },
    "computer.sleep": async (payload) => {
      await sleepComputerIfIdle(deps, payload.computerId);
    },
    "computer.control-expire": async (payload) => {
      if (await expireComputerControl(deps, payload.computerId, payload.leaseId)) {
        scheduleComputerSleep(deps.jobs, payload.computerId);
      }
    },
    "skill.teaching-expire": async (payload) => {
      if (deps.onSkillTeachingExpire) {
        await deps.onSkillTeachingExpire(payload.skillId);
        return;
      }
      await expireTaughtSkillTeaching(deps, payload.skillId);
    },
  };
}
