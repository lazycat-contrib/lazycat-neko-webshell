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

export type SshConfigHost = {
  alias: string;
  host: string;
  username: string;
  port?: number;
  source: string;
  identityFiles: string[];
  certificateFiles: string[];
  proxyJump: string;
  proxyCommand: string;
};

export type SshConfigOption = {
  key: string;
  value: string;
};

export type SshConfigDocumentHost = {
  startLine: number;
  endLine: number;
  patterns: string[];
  options: SshConfigOption[];
  hostName: string;
  user: string;
  port?: number;
  identityFiles: string[];
  certificateFiles: string[];
  proxyJump: string;
  proxyCommand: string;
  forwardAgent: string;
  strictHostKeyChecking: string;
  serverAliveInterval?: number;
  serverAliveCountMax?: number;
  compression: string;
  connectionAttempts?: number;
  connectTimeout?: number;
  localForwards: string[];
  remoteForwards: string[];
  dynamicForwards: string[];
  pubkeyAcceptedAlgorithms: string;
  pubkeyAcceptedKeyTypes: string;
  hostKeyAlgorithms: string;
  extraOptions: SshConfigOption[];
};

export type SshConfigDocument = {
  globals: SshConfigOption[];
  hosts: SshConfigDocumentHost[];
  matches: Array<{
    condition: string;
    options: SshConfigOption[];
  }>;
  includes: string[];
  warnings: string[];
};

export type SshConfigView = {
  source: string;
  content: string;
  document: SshConfigDocument;
  hosts: SshConfigHost[];
};

export type SshConfigSaveResponse = {
  source: string;
  backupPath?: string;
  document: SshConfigDocument;
  hosts: SshConfigHost[];
};

export type SshKeyFileView = {
  path: string;
  source: string;
  exists: boolean;
  content: string;
  backupPath?: string;
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

export async function fetchSshConfigHosts(selector?: string): Promise<SshConfigHost[]> {
  const url = new URL("./api/ssh-config-hosts", window.location.href);
  if (selector?.trim()) {
    url.searchParams.set("name", selector.trim());
  }
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  const payload = await response.json() as unknown;
  return Array.isArray(payload) ? payload as SshConfigHost[] : [];
}

export async function fetchSshConfig(selector?: string): Promise<SshConfigView> {
  const url = new URL("./api/ssh-config", window.location.href);
  if (selector?.trim()) {
    url.searchParams.set("name", selector.trim());
  }
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  return response.json() as Promise<SshConfigView>;
}

export async function saveSshConfig(
  content: string,
  options: {
    selector?: string;
    backupLimit: number;
  },
): Promise<SshConfigSaveResponse> {
  const url = new URL("./api/ssh-config", window.location.href);
  if (options.selector?.trim()) {
    url.searchParams.set("name", options.selector.trim());
  }
  const response = await fetch(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      backupLimit: options.backupLimit,
    }),
  });
  await throwIfFailed(response);
  return response.json() as Promise<SshConfigSaveResponse>;
}

export async function fetchSshKeyFile(
  path: string,
  options: { selector?: string } = {},
): Promise<SshKeyFileView> {
  const url = new URL("./api/ssh-key-file", window.location.href);
  url.searchParams.set("path", path);
  if (options.selector?.trim()) {
    url.searchParams.set("name", options.selector.trim());
  }
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  return response.json() as Promise<SshKeyFileView>;
}

export async function saveSshKeyFile(
  path: string,
  content: string,
  options: {
    selector?: string;
    backupLimit: number;
  },
): Promise<SshKeyFileView> {
  const url = new URL("./api/ssh-key-file", window.location.href);
  url.searchParams.set("path", path);
  if (options.selector?.trim()) {
    url.searchParams.set("name", options.selector.trim());
  }
  const response = await fetch(url, {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content,
      backupLimit: options.backupLimit,
    }),
  });
  await throwIfFailed(response);
  return response.json() as Promise<SshKeyFileView>;
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
