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

const EMAIL_CONNECTOR_SLUGS = new Set(["gmail", "outlook", "microsoft_outlook"]);
const PURCHASE_CONNECTOR_SLUGS = new Set(["stripe", "shopify", "paypal", "square"]);

export type ActionApprovalEffect = "always_allow" | "require_approval";
export type ActionApprovalMatchKind = "tool" | "connector" | "category";

export type ActionApprovalRule = {
  effect: ActionApprovalEffect;
  matchKind: ActionApprovalMatchKind;
  matchValue: string;
};

export function connectorKindFromToolName(toolName: string): string {
  const [segment] = toolName.split("_");
  return (segment ?? toolName).toLowerCase();
}

export function connectorToolRequiresApproval(toolName: string): boolean {
  return !READ_ONLY_CONNECTOR_PATTERN.test(toolName);
}

export function toolRequiresApproval(toolName: string, viaConnector: boolean): boolean {
  if (APPROVAL_EXEMPT_TOOLS.has(toolName)) return false;
  if (APPROVAL_REQUIRED_BUILTIN_TOOLS.has(toolName)) return true;
  if (viaConnector) return connectorToolRequiresApproval(toolName);
  return false;
}

function categoryMatches(category: string, toolName: string, connectorKind: string): boolean {
  const normalized = category.toLowerCase();
  if (normalized === "email") {
    if (EMAIL_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return true;
    return /send.*mail|gmail_send|outlook_send/i.test(toolName);
  }
  if (normalized === "purchase") {
    if (PURCHASE_CONNECTOR_SLUGS.has(connectorKind.toLowerCase())) return true;
    return /purchase|pay_|charge|checkout|buy_/i.test(toolName);
  }
  return false;
}

function ruleMatches(rule: ActionApprovalRule, toolName: string, connectorKind: string): boolean {
  const value = rule.matchValue.toLowerCase();
  switch (rule.matchKind) {
    case "tool":
      return toolName.toLowerCase() === value;
    case "connector":
      return connectorKind.toLowerCase() === value;
    case "category":
      return categoryMatches(rule.matchValue, toolName, connectorKind);
    default:
      return false;
  }
}

export function resolveActionApproval(input: {
  toolName: string;
  viaConnector: boolean;
  connectorKind?: string;
  rules: ActionApprovalRule[];
}): "ask" | "allow" {
  const connectorKind = input.connectorKind ?? connectorKindFromToolName(input.toolName);
  if (input.rules.some((rule) => rule.effect === "require_approval" && ruleMatches(rule, input.toolName, connectorKind))) {
    return "ask";
  }
  if (input.rules.some((rule) => rule.effect === "always_allow" && ruleMatches(rule, input.toolName, connectorKind))) {
    return "allow";
  }
  return toolRequiresApproval(input.toolName, input.viaConnector) ? "ask" : "allow";
}

export function isApprovalAskBlock(block: {
  kind: string;
  actions?: Array<{ id: string; label: string }>;
}): boolean {
  return (
    block.kind === "ask" &&
    Boolean(
      block.actions?.some(
        (action) => action.id === "allow" || action.id === "always" || action.id === "deny",
      ),
    )
  );
}
