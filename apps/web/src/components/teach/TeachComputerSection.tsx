import type { ComputerStatus, TaughtSkill } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { useMemo, useState } from "react";
import { rpc } from "../../lib/rpc";

function formatRemaining(expiresAt: string | null): string {
  if (!expiresAt) return "10:00";
  const ms = Math.max(0, new Date(expiresAt).getTime() - Date.now());
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export function TeachComputerSection({
  botId,
  computer,
  skills,
  onRefresh,
  onOpenComputer,
  onAddRoutine,
}: {
  botId: string;
  computer: ComputerStatus | null;
  skills: TaughtSkill[];
  onRefresh: () => Promise<void>;
  onOpenComputer: () => Promise<void>;
  onAddRoutine: (skill: TaughtSkill) => void;
}) {
  const [goalOpen, setGoalOpen] = useState(false);
  const [goal, setGoal] = useState("");
  const [busy, setBusy] = useState(false);
  const recording = useMemo(
    () => skills.find((skill) => skill.status === "recording") ?? null,
    [skills],
  );
  const saved = useMemo(
    () => skills.filter((skill) => skill.status === "saved" || skill.status === "draft"),
    [skills],
  );
  const teachAvailable =
    computer && computer.kind !== "desktop" && computer.screenAvailable !== false;

  async function startTeaching() {
    if (!goal.trim() || busy) return;
    setBusy(true);
    try {
      await rpc.computer.boot({ botId });
      await rpc.skills.start({ botId, goal: goal.trim() });
      setGoalOpen(false);
      setGoal("");
      await onOpenComputer();
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function stopTeaching() {
    if (!recording || busy) return;
    setBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-[30px]">
      <div className="mb-3 text-[14px] text-[#85858A]">Teach a task</div>
      {!teachAvailable ? (
        <div className="rounded-[11px] border border-[#232326] px-3 py-3 text-[13.5px] leading-[1.5] text-[#6C6C70]">
          {computer?.kind === "desktop"
            ? "Teaching needs a graphical sandbox computer. Desktop-host bots can run shell tasks, but not screen recording."
            : "Open the computer view on web or desktop to teach a task."}
        </div>
      ) : recording ? (
        <div
          data-testid="teach-recording"
          className="rounded-[11px] border border-[#232326] bg-[#121214] px-3 py-3"
        >
          <div className="text-[14px] text-[#ECECEE]">Recording: {recording.goal}</div>
          <div className="mt-1 text-[13px] text-[#85858A]">
            {formatRemaining(recording.expiresAt)} left · bot is watching, not acting
          </div>
          <div className="mt-2 text-[13px] text-[#E65707]">
            Do not type passwords into the demo. Use Take control for credentials.
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-3"
            disabled={busy}
            onClick={() => void stopTeaching()}
          >
            Stop teaching
          </Button>
        </div>
      ) : goalOpen ? (
        <div className="rounded-[11px] border border-[#232326] bg-[#121214] px-3 py-3">
          <label htmlFor="teach-goal-input" className="text-[13px] text-[#85858A]">
            What result will you demonstrate?
          </label>
          <textarea
            id="teach-goal-input"
            data-testid="teach-goal-input"
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            rows={3}
            className="mt-2 w-full rounded-[10px] border border-[#26262A] bg-[#0E0E10] px-3 py-2 text-[14px] text-[#ECECEE] outline-none"
            placeholder="Export this week's list from the CRM and drop it in the shared folder"
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={busy || !goal.trim()}
              onClick={() => void startTeaching()}
              className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[14px] text-[#17171A] disabled:opacity-40"
            >
              {busy ? "Starting…" : "Start recording"}
            </button>
            <button
              type="button"
              onClick={() => setGoalOpen(false)}
              className="rounded-[11px] border border-[#26262A] px-4 py-2 text-[14px] text-[#ECECEE]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          data-testid="teach-start-button"
          onClick={() => setGoalOpen(true)}
          className="flex items-center gap-2.5 px-2.5 py-2.5 text-[14.5px] text-[#7A7A80]"
        >
          + Teach a task
        </button>
      )}

      {saved.length > 0 ? (
        <>
          <div className="mt-[22px] mb-3 text-[14px] text-[#85858A]">Saved skills</div>
          {saved.map((skill) => (
            <div key={skill.id} className="mb-2 rounded-[11px] border border-[#232326] px-3 py-3">
              <div className="text-[14px] text-[#ECECEE]">{skill.name || skill.goal}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await rpc.skills.testRun({ skillId: skill.id });
                      await onRefresh();
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="rounded-[11px] border border-[#26262A] px-3 py-1.5 text-[13px] text-[#ECECEE]"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => onAddRoutine(skill)}
                  className="rounded-[11px] border border-[#26262A] px-3 py-1.5 text-[13px] text-[#ECECEE]"
                >
                  Add to routine
                </button>
                <button
                  type="button"
                  disabled={busy || skill.status !== "draft"}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await rpc.skills.save({ skillId: skill.id });
                      await onRefresh();
                    } finally {
                      setBusy(false);
                    }
                  }}
                  className="rounded-[11px] bg-[#F1F1EF] px-3 py-1.5 text-[13px] text-[#17171A] disabled:opacity-40"
                >
                  Save
                </button>
              </div>
            </div>
          ))}
        </>
      ) : null}
    </div>
  );
}
