import type { MessageBlock } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";

const BUILTIN_TOOL_NAMES = new Set([
  "computer_observe",
  "computer_act",
  "list_files",
  "read_file",
  "write_file",
  "shell",
  "open_path",
  "launch_app",
  "remember",
  "request_takeover",
  "run_subagent",
  "spawn_bot",
  "archive_bot",
  "delete_bot",
]);

export function resolvesViaConnector(toolName: string): boolean {
  return !BUILTIN_TOOL_NAMES.has(toolName);
}

export function buildApprovalAskBlock(
  toolName: string,
  args: Record<string, unknown>,
  secrets: string[],
): MessageBlock {
  const summary = describeApprovalAction(toolName, args);
  const detail = formatApprovalDetail(args, secrets);
  return {
    kind: "ask",
    text: redactSecrets(`Review before ${summary}`, secrets),
    detail: detail ? redactSecrets(detail, secrets) : undefined,
    status: "pending",
    actions: [
      { id: "allow", label: "Allow once" },
      { id: "always", label: "Always allow" },
      { id: "deny", label: "Deny" },
    ],
  };
}

function describeApprovalAction(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "destination.write") {
    const collection = args.collection ? String(args.collection) : "records";
    const title = args.title ? ` "${String(args.title)}"` : "";
    return `writing${title} to ${collection}`;
  }
  if (toolName === "delete_bot" || toolName === "archive_bot") {
    const name = args.confirm_name ?? args.confirmName;
    return name ? `${toolName.replace("_", " ")} (${String(name)})` : toolName.replace("_", " ");
  }
  const target = pickScopeLabel(args);
  return target ? `${toolName} → ${target}` : toolName;
}

function formatApprovalDetail(
  args: Record<string, unknown>,
  secrets: string[],
): string | undefined {
  const lines: string[] = [];
  for (const key of ["collection", "title", "to", "subject", "amount", "body"]) {
    const value = args[key];
    if (value == null || value === "") continue;
    lines.push(`${key}: ${String(value)}`);
  }
  if (lines.length === 0) return undefined;
  return redactSecrets(lines.join("\n"), secrets);
}

function pickScopeLabel(args: Record<string, unknown>): string | undefined {
  for (const key of ["to", "title", "collection", "subject", "amount"]) {
    const value = args[key];
    if (value != null && value !== "") return String(value);
  }
  return undefined;
}
