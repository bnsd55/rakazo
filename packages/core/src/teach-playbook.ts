export type TeachRecordingEvent = {
  at: string;
  kind: "pointer" | "key" | "clipboard" | "snapshot";
  x?: number;
  y?: number;
  button?: string;
  type?: string;
  key?: string;
  text?: string;
  summary?: string;
};

export type TeachSnapshot = {
  at: string;
  summary: string;
  hash?: string;
};

export type SkillPlaybook = {
  whenToUse: string;
  inputs: string[];
  steps: string[];
  howToCheck: string;
  whatToReturn: string;
  approvalBoundaries: string;
  failureHandling: string;
};

const DEFAULT_APPROVAL =
  "Do not send messages, spend money, publish content, or delete data without explicit user approval.";
const DEFAULT_FAILURE =
  "If a step fails or the expected screen is not visible, stop and ask the user before retrying.";

function describePointer(event: TeachRecordingEvent): string {
  const action = event.type ?? "click";
  const button = event.button ?? "left";
  if (action === "move") {
    return `Move pointer to (${event.x ?? 0}, ${event.y ?? 0}).`;
  }
  return `${action === "click" ? "Click" : action} ${button} button at (${event.x ?? 0}, ${event.y ?? 0}).`;
}

function redactSensitiveText(text: string): string {
  const trimmed = text.trim();
  if (/password|secret|token|api[_-]?key/i.test(trimmed)) return "[redacted input]";
  return trimmed;
}

export function buildPlaybookFromRecording(
  goal: string,
  events: TeachRecordingEvent[],
  snapshots: TeachSnapshot[] = [],
): SkillPlaybook {
  const steps: string[] = [];
  for (const event of events) {
    if (event.kind === "pointer") {
      steps.push(describePointer(event));
    } else if (event.kind === "key") {
      const key = event.key?.trim();
      if (key) steps.push(`Press key: ${key}.`);
    } else if (event.kind === "clipboard") {
      const text = event.text ? redactSensitiveText(event.text) : "";
      if (text) steps.push(`Paste or type: ${text}.`);
    } else if (event.kind === "snapshot" && event.summary) {
      steps.push(`Verify screen: ${event.summary}.`);
    }
  }
  for (const snapshot of snapshots) {
    if (snapshot.summary) steps.push(`Confirm screen state: ${snapshot.summary}.`);
  }
  if (steps.length === 0) {
    steps.push("Repeat the demonstrated workflow using the same navigation pattern.");
  }

  return {
    whenToUse: goal.trim() || "When the user asks to repeat the demonstrated task.",
    inputs: goal.trim() ? [goal.trim()] : [],
    steps,
    howToCheck: snapshots.at(-1)?.summary
      ? `The final screen should match: ${snapshots.at(-1)?.summary}.`
      : "Confirm the outcome matches the user's goal before reporting success.",
    whatToReturn: "A short summary of what was completed and where outputs were saved.",
    approvalBoundaries: DEFAULT_APPROVAL,
    failureHandling: DEFAULT_FAILURE,
  };
}

export function formatSkillRunPrompt(name: string, playbook: SkillPlaybook, test = false): string {
  const safety = test
    ? "This is a safe test run. Do not send, spend, delete, or publish anything."
    : "";
  return [
    `Run taught skill: ${name}`,
    safety,
    `When to use: ${playbook.whenToUse}`,
    playbook.inputs.length ? `Inputs: ${playbook.inputs.join("; ")}` : undefined,
    "Steps:",
    ...playbook.steps.map((step, index) => `${index + 1}. ${step}`),
    `How to check: ${playbook.howToCheck}`,
    `Return: ${playbook.whatToReturn}`,
    `Approval boundaries: ${playbook.approvalBoundaries}`,
    `Failure handling: ${playbook.failureHandling}`,
  ]
    .filter(Boolean)
    .join("\n");
}
