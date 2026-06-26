import type { SshConfigDocumentHost, SshConfigOption } from "./api";

export type SshConfigHostDraft = {
  originalAlias: string;
  startLine?: number;
  endLine?: number;
  host: string;
  hostName: string;
  user: string;
  port: string;
  identityFile: string;
  certificateFile: string;
  proxyJump: string;
  proxyCommand: string;
  forwardAgent: string;
  strictHostKeyChecking: string;
  serverAliveInterval: string;
  localForward: string;
  remoteForward: string;
  dynamicForward: string;
  extraOptionsText: string;
};

export function emptyHostDraft(): SshConfigHostDraft {
  return {
    originalAlias: "",
    host: "",
    hostName: "",
    user: "",
    port: "",
    identityFile: "",
    certificateFile: "",
    proxyJump: "",
    proxyCommand: "",
    forwardAgent: "",
    strictHostKeyChecking: "",
    serverAliveInterval: "",
    localForward: "",
    remoteForward: "",
    dynamicForward: "",
    extraOptionsText: "",
  };
}

export function hostDraftFromDocumentHost(host: SshConfigDocumentHost): SshConfigHostDraft {
  const alias = host.patterns.find((pattern) => selectableHostPattern(pattern)) || host.patterns[0] || "";
  return {
    originalAlias: alias,
    startLine: host.startLine,
    endLine: host.endLine,
    host: host.patterns.join(" "),
    hostName: host.hostName,
    user: host.user,
    port: host.port ? String(host.port) : "",
    identityFile: host.identityFiles[0] || "",
    certificateFile: host.certificateFiles[0] || "",
    proxyJump: host.proxyJump,
    proxyCommand: host.proxyCommand,
    forwardAgent: host.forwardAgent,
    strictHostKeyChecking: host.strictHostKeyChecking,
    serverAliveInterval: host.serverAliveInterval ? String(host.serverAliveInterval) : "",
    localForward: host.localForwards[0] || "",
    remoteForward: host.remoteForwards[0] || "",
    dynamicForward: host.dynamicForwards[0] || "",
    extraOptionsText: extraOptionsText(host.extraOptions),
  };
}

export function applyHostDraftToConfig(content: string, draft: SshConfigHostDraft): string {
  const block = serializeHostDraft(draft);
  if (draft.startLine && draft.endLine && draft.endLine >= draft.startLine) {
    const lines = content.split(/\r?\n/);
    const start = Math.max(0, draft.startLine - 1);
    const deleteCount = Math.max(1, draft.endLine - draft.startLine + 1);
    lines.splice(start, deleteCount, ...block.trimEnd().split("\n"));
    return ensureTrailingNewline(lines.join("\n"));
  }
  const trimmed = content.trimEnd();
  return `${trimmed}${trimmed ? "\n\n" : ""}${block}`;
}

export function serializeHostDraft(draft: SshConfigHostDraft): string {
  const host = draft.host.trim().replace(/\s+/g, " ");
  if (!host) {
    throw new Error("Host is required");
  }
  const lines = [`Host ${host}`];
  pushOption(lines, "HostName", draft.hostName);
  pushOption(lines, "User", draft.user);
  const port = draft.port.trim();
  if (port) {
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      throw new Error("Port must be between 1 and 65535");
    }
    lines.push(`  Port ${port}`);
  }
  pushOption(lines, "IdentityFile", draft.identityFile);
  pushOption(lines, "CertificateFile", draft.certificateFile);
  pushOption(lines, "ProxyJump", draft.proxyJump);
  pushOption(lines, "ProxyCommand", draft.proxyCommand);
  pushOption(lines, "ForwardAgent", draft.forwardAgent);
  pushOption(lines, "StrictHostKeyChecking", draft.strictHostKeyChecking);
  pushOption(lines, "ServerAliveInterval", draft.serverAliveInterval);
  pushOption(lines, "LocalForward", draft.localForward);
  pushOption(lines, "RemoteForward", draft.remoteForward);
  pushOption(lines, "DynamicForward", draft.dynamicForward);
  for (const option of parseExtraOptionsText(draft.extraOptionsText)) {
    lines.push(`  ${option.key} ${option.value}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseExtraOptionsText(value: string): SshConfigOption[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.search(/\s/);
      if (separator <= 0) {
        throw new Error(`Invalid SSH option: ${line}`);
      }
      const key = line.slice(0, separator).trim();
      const optionValue = line.slice(separator + 1).trim();
      if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(key) || !optionValue) {
        throw new Error(`Invalid SSH option: ${line}`);
      }
      return { key, value: optionValue };
    });
}

function pushOption(lines: string[], key: string, value: string) {
  const trimmed = value.trim();
  if (trimmed) {
    lines.push(`  ${key} ${trimmed}`);
  }
}

function extraOptionsText(options: SshConfigOption[]): string {
  return options.map((option) => `${option.key} ${option.value}`).join("\n");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function selectableHostPattern(value: string): boolean {
  return Boolean(value)
    && !value.startsWith("-")
    && !value.startsWith("!")
    && !/[?[*\s]/.test(value);
}
