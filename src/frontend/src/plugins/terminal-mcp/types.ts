export type TerminalMcpPolicyMode =
  | "confirm"
  | "trusted_callers"
  | "same_user_automatic"
  | "read_only";

export type TerminalMcpPolicy = {
  mode: TerminalMcpPolicyMode;
  trustedCallers: string[];
  deniedCallers: string[];
};

export type TerminalMcpPolicyAccess = "confirm" | "automatic" | "denied";
export type TerminalCapability = "interact" | "create" | "terminate";
export type ControlDecision = "pending" | "approved" | "denied" | "revoked";

export type ControlTarget = {
  sessionId: string;
  backend: "webshell" | "ssh" | "herdr";
  label: string;
};

export type ControlRequest = {
  id: string;
  userId: string;
  callerAppId: string;
  callerName: string;
  target: ControlTarget;
  capability: TerminalCapability;
  reason: string;
  decision: ControlDecision;
  createdAtMs: number;
};

export type ControlGrant = {
  id: string;
  userId: string;
  callerAppId: string;
  callerName: string;
  target: ControlTarget;
  capabilities: TerminalCapability[];
  createdAtMs: number;
};

export type TerminalMcpControlState = {
  pendingRequests: ControlRequest[];
  activeGrants: ControlGrant[];
};

export type TerminalMcpPluginSnapshot = {
  enabled: boolean;
  metadata: Record<string, string>;
};
