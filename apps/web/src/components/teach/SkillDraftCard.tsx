import type { SkillPlaybook } from "@rakazo/contracts";
import { useState } from "react";
import { rpc } from "../../lib/rpc";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const [name, setName] = useState(block.name);
  const [playbook, setPlaybook] = useState(block.playbook);
  const [busy, setBusy] = useState(false);

  async function saveDraft() {
    setBusy(true);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      await rpc.skills.save({ skillId: block.skillId, name });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  async function testDraft() {
    setBusy(true);
    try {
      await rpc.skills.updateDraft({ skillId: block.skillId, name, playbook });
      await rpc.skills.testRun({ skillId: block.skillId });
      await onRefresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-testid="skill-draft-card"
      className="w-[min(520px,92%)] rounded-[20px] border border-[#242428] bg-[#141417] px-[18px] py-4"
    >
      <div className="text-[15px] font-medium text-[#ECECEE]">Draft skill</div>
      <div className="mt-1 text-[13.5px] text-[#85858A]">{block.goal}</div>
      <label htmlFor="skill-draft-name" className="mt-4 block text-[13px] text-[#85858A]">
        Name
      </label>
      <input
        id="skill-draft-name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="mt-1 w-full rounded-[10px] border border-[#26262A] bg-[#0E0E10] px-3 py-2 text-[14px] text-[#ECECEE] outline-none"
      />
      <label htmlFor="skill-draft-when" className="mt-3 block text-[13px] text-[#85858A]">
        When to use
      </label>
      <textarea
        id="skill-draft-when"
        value={playbook.whenToUse}
        onChange={(event) => setPlaybook({ ...playbook, whenToUse: event.target.value })}
        rows={2}
        className="mt-1 w-full rounded-[10px] border border-[#26262A] bg-[#0E0E10] px-3 py-2 text-[14px] text-[#ECECEE] outline-none"
      />
      <label htmlFor="skill-draft-steps" className="mt-3 block text-[13px] text-[#85858A]">
        Steps
      </label>
      <textarea
        id="skill-draft-steps"
        value={playbook.steps.join("\n")}
        onChange={(event) =>
          setPlaybook({
            ...playbook,
            steps: event.target.value.split("\n").filter(Boolean),
          })
        }
        rows={5}
        className="mt-1 w-full rounded-[10px] border border-[#26262A] bg-[#0E0E10] px-3 py-2 text-[14px] text-[#ECECEE] outline-none"
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy || block.status === "saved"}
          onClick={() => void saveDraft()}
          className="rounded-[11px] bg-[#F1F1EF] px-4 py-2 text-[14px] text-[#17171A] disabled:opacity-40"
        >
          {block.status === "saved" ? "Saved" : busy ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void testDraft()}
          className="rounded-[11px] border border-[#26262A] px-4 py-2 text-[14px] text-[#ECECEE]"
        >
          Test
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onAddRoutine(
              name || block.name,
              `Run taught skill: ${name || block.name}\n${playbook.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}`,
            )
          }
          className="rounded-[11px] border border-[#26262A] px-4 py-2 text-[14px] text-[#ECECEE]"
        >
          Add to routine
        </button>
      </div>
    </div>
  );
}
