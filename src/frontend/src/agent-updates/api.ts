export type AgentUpdateStatus = {
  selector: string;
  kind: "required" | "optional" | "pending_restart" | "ready" | "provider_older";
  currentVersion: number | null;
  latestVersion: number;
  minimumVersion: number;
  protocol: string | null;
  payloadManifest: string | null;
};

async function read(response: Response): Promise<AgentUpdateStatus> {
  const value = await response.json();
  if (!response.ok) throw new Error(value.code || "update_failed");
  if (!value || typeof value.selector !== "string"
    || !["required", "optional", "pending_restart", "ready", "provider_older"].includes(value.kind)
    || !Number.isSafeInteger(value.latestVersion) || value.latestVersion < 1
    || !Number.isSafeInteger(value.minimumVersion) || value.minimumVersion < 1
    || (value.currentVersion !== null && (!Number.isSafeInteger(value.currentVersion) || value.currentVersion < 1))
    || (value.protocol !== null && typeof value.protocol !== "string")
    || (value.payloadManifest !== null && typeof value.payloadManifest !== "string")) {
    throw new Error("invalid_update_status");
  }
  return value as AgentUpdateStatus;
}

export async function inspectAgentUpdate(selector: string): Promise<AgentUpdateStatus> {
  const url = new URL("./api/agent/update", window.location.href);
  url.searchParams.set("name", selector);
  return read(await fetch(url, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(15000) }));
}

export async function requestAgentUpdate(status: AgentUpdateStatus, optional: boolean): Promise<AgentUpdateStatus> {
  return read(await fetch(new URL("./api/agent/update", window.location.href), {
    method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ name: status.selector, optional, expectedVersion: status.currentVersion,
      expectedProtocol: status.protocol, expectedManifest: status.payloadManifest }),
  }));
}
