export type SshProfileKind = "managed-key" | "device-openssh";

export type SshProfile = {
  id: string;
  selector: string;
  name: string;
  kind: SshProfileKind;
  enabled: boolean;
  host: string;
  port?: number;
  username: string;
  target: string;
  publicKey: string;
  strictHostKeyChecking: "accept-new" | "yes" | "no";
  createdAtMs: number;
  updatedAtMs: number;
  lastUsedAtMs?: number;
};

export type SshProfileSaveInput = {
  id?: string;
  name: string;
  kind: SshProfileKind;
  enabled: boolean;
  host?: string;
  port?: number;
  username?: string;
  target?: string;
  strictHostKeyChecking: "accept-new" | "yes" | "no";
};

export async function fetchSshProfiles(): Promise<SshProfile[]> {
  const response = await fetch(new URL("./api/ssh-profiles", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  const payload = await response.json() as unknown;
  return Array.isArray(payload) ? payload as SshProfile[] : [];
}

export async function saveSshProfile(input: SshProfileSaveInput): Promise<SshProfile> {
  const response = await fetch(new URL("./api/ssh-profiles", window.location.href), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  await throwIfFailed(response);
  return response.json() as Promise<SshProfile>;
}

export async function deleteSshProfile(id: string): Promise<void> {
  const response = await fetch(new URL(`./api/ssh-profiles/${encodeURIComponent(id)}`, window.location.href), {
    method: "DELETE",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
}

export async function testSshProfile(id: string): Promise<string> {
  const response = await fetch(new URL(`./api/ssh-profiles/${encodeURIComponent(id)}/test`, window.location.href), {
    method: "POST",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  const payload = await response.json() as { message?: string };
  return payload.message || "SSH connection succeeded";
}

async function throwIfFailed(response: Response) {
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
}
