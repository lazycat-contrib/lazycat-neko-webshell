import type {
  TerminalMcpPolicy,
  TerminalMcpPolicyAccess,
  TerminalMcpPolicyMode,
} from "./types.ts";

export const TERMINAL_MCP_DEFAULT_POLICY_METADATA = "defaultPolicy";
export const TERMINAL_MCP_TRUSTED_CALLERS_METADATA = "trustedCallers";
export const TERMINAL_MCP_DENIED_CALLERS_METADATA = "deniedCallers";

const POLICY_MODES = new Set<TerminalMcpPolicyMode>([
  "confirm",
  "trusted_callers",
  "same_user_automatic",
  "read_only",
]);
const MAX_CALLERS = 128;
const MAX_CALLER_ID_LENGTH = 256;

export function normalizeTerminalMcpPolicy(
  metadata: Record<string, string> | undefined,
): TerminalMcpPolicy {
  const mode = normalizePolicyMode(metadata?.[TERMINAL_MCP_DEFAULT_POLICY_METADATA]);
  const deniedCallers = normalizeCallerIds(parseCallerList(
    metadata?.[TERMINAL_MCP_DENIED_CALLERS_METADATA],
  ));
  const denied = new Set(deniedCallers);
  const trustedCallers = normalizeCallerIds(parseCallerList(
    metadata?.[TERMINAL_MCP_TRUSTED_CALLERS_METADATA],
  )).filter((caller) => !denied.has(caller));
  return { mode, trustedCallers, deniedCallers };
}

export function serializeTerminalMcpPolicy(
  policy: TerminalMcpPolicy,
): Record<string, string> {
  const deniedCallers = normalizeCallerIds(policy.deniedCallers);
  const denied = new Set(deniedCallers);
  const trustedCallers = normalizeCallerIds(policy.trustedCallers)
    .filter((caller) => !denied.has(caller));
  return {
    [TERMINAL_MCP_DEFAULT_POLICY_METADATA]: normalizePolicyMode(policy.mode),
    [TERMINAL_MCP_TRUSTED_CALLERS_METADATA]: JSON.stringify(trustedCallers),
    [TERMINAL_MCP_DENIED_CALLERS_METADATA]: JSON.stringify(deniedCallers),
  };
}

export function callerIdsFromText(value: string): string[] {
  return normalizeCallerIds(value.split(/[\n,]/));
}

export function terminalMcpPolicyAccess(
  policy: TerminalMcpPolicy,
  callerAppId: string,
): TerminalMcpPolicyAccess {
  const caller = callerAppId.trim();
  if (policy.deniedCallers.includes(caller)) return "denied";
  if (policy.mode === "read_only") return "denied";
  if (policy.mode === "same_user_automatic") return "automatic";
  if (policy.mode === "trusted_callers" && policy.trustedCallers.includes(caller)) {
    return "automatic";
  }
  return "confirm";
}

function normalizePolicyMode(value: unknown): TerminalMcpPolicyMode {
  return typeof value === "string" && POLICY_MODES.has(value as TerminalMcpPolicyMode)
    ? value as TerminalMcpPolicyMode
    : "confirm";
}

function parseCallerList(value: string | undefined): unknown[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeCallerIds(values: readonly unknown[]): string[] {
  return Array.from(new Set(values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && value.length <= MAX_CALLER_ID_LENGTH)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_CALLERS);
}
