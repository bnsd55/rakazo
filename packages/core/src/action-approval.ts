const APPROVAL_EXEMPT_TOOLS = new Set([
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
]);

const APPROVAL_REQUIRED_BUILTIN_TOOLS = new Set(["destination.write", "delete_bot", "archive_bot"]);

const READ_ONLY_CONNECTOR_PATTERN = /(^|_)(get|list|search|find|read)/i;

export function connectorToolRequiresApproval(toolName: string): boolean {
  return !READ_ONLY_CONNECTOR_PATTERN.test(toolName);
}

export function toolRequiresApproval(toolName: string, viaConnector: boolean): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName);
  return false;
}

export function isApprovalAskBlock(block: {
  kind: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  return (
    block.kind === "ask" &&
    Boolean(block.actions?.some((action) => action.id === "allow" || action.id === "deny"))
  );
}
