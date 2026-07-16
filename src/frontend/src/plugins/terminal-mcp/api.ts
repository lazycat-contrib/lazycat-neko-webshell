import type {
  ControlDecision,
  ControlGrant,
  ControlRequest,
  ControlTarget,
  TerminalCapability,
  TerminalMcpControlState,
} from "./types.ts";

export async function fetchTerminalMcpControlState(): Promise<TerminalMcpControlState> {
  const response = await fetch(apiUrl("control-state"), requestInit());
  const value = await readJsonResponse(response, "failed to load Terminal MCP control state");
  if (!isRecord(value)) return emptyControlState();
  return {
    pendingRequests: Array.isArray(value.pendingRequests)
      ? value.pendingRequests.map(normalizeRequest).filter(isDefined)
      : [],
    activeGrants: Array.isArray(value.activeGrants)
      ? value.activeGrants.map(normalizeGrant).filter(isDefined)
      : [],
  };
}

export async function approveTerminalMcpRequest(requestId: string): Promise<void> {
  await postControlMutation(`requests/${encodeURIComponent(requestId)}/approve`);
}

export async function denyTerminalMcpRequest(requestId: string): Promise<void> {
  await postControlMutation(`requests/${encodeURIComponent(requestId)}/deny`);
}

export async function revokeTerminalMcpGrant(grantId: string): Promise<void> {
  await postControlMutation(`grants/${encodeURIComponent(grantId)}/revoke`);
}

async function postControlMutation(path: string): Promise<void> {
  const response = await fetch(apiUrl(path), { ...requestInit(), method: "POST" });
  await readJsonResponse(response, "Terminal MCP control action failed");
}

function apiUrl(path: string): URL {
  return new URL(`./api/plugins/terminal-mcp/${path}`, window.location.href);
}

function requestInit(): RequestInit {
  return {
    cache: "no-store",
    credentials: "same-origin",
  };
}

async function readJsonResponse(response: Response, fallback: string): Promise<unknown> {
  const text = await response.text();
  let value: unknown;
  if (text.trim()) {
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      value = undefined;
    }
  }
  if (!response.ok) {
    const message = isRecord(value) && isRecord(value.error)
      ? stringValue(value.error.message, 512)
      : "";
    throw new Error(message || text.trim() || fallback);
  }
  return value;
}

function normalizeRequest(value: unknown): ControlRequest | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id, 256);
  const callerAppId = stringValue(value.callerAppId, 256);
  const target = normalizeTarget(value.target);
  if (!id || !callerAppId || !target) return undefined;
  const decision = normalizeDecision(value.decision);
  const capability = optionalCapability(value.capability);
  if (decision !== "pending" || !capability) return undefined;
  return {
    id,
    userId: stringValue(value.userId, 256),
    callerAppId,
    callerName: stringValue(value.callerName, 256) || callerAppId,
    target,
    capability,
    reason: stringValue(value.reason, 512),
    decision,
    createdAtMs: timestampValue(value.createdAtMs),
  };
}

function normalizeGrant(value: unknown): ControlGrant | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id, 256);
  const callerAppId = stringValue(value.callerAppId, 256);
  const target = normalizeTarget(value.target);
  if (!id || !callerAppId || !target) return undefined;
  const capabilities = Array.isArray(value.capabilities)
    ? Array.from(new Set(value.capabilities.map(optionalCapability).filter(isDefined)))
    : [];
  return {
    id,
    userId: stringValue(value.userId, 256),
    callerAppId,
    callerName: stringValue(value.callerName, 256) || callerAppId,
    target,
    capabilities,
    createdAtMs: timestampValue(value.createdAtMs),
  };
}

function normalizeTarget(value: unknown): ControlTarget | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = stringValue(value.sessionId, 256);
  const backend = normalizeBackend(value.backend);
  if (!sessionId || !backend) return undefined;
  return {
    sessionId,
    backend,
    label: stringValue(value.label, 256) || sessionId,
  };
}

function optionalCapability(value: unknown): TerminalCapability | undefined {
  return value === "interact" || value === "create" || value === "terminate" ? value : undefined;
}

function normalizeBackend(value: unknown): ControlTarget["backend"] | undefined {
  return value === "webshell" || value === "ssh" || value === "herdr" ? value : undefined;
}

function normalizeDecision(value: unknown): ControlDecision {
  if (value === "approved" || value === "denied" || value === "revoked") return value;
  return "pending";
}

function emptyControlState(): TerminalMcpControlState {
  return { pendingRequests: [], activeGrants: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function stringValue(value: unknown, maxLength: number): string {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function timestampValue(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
