import {
  fetchSshConfigHosts,
  fetchSshProfiles,
  saveSshProfile,
  type SshConfigHost,
  type SshProfile,
  type SshProfileSaveInput,
} from "./api";

const SSH_URL_PARAM_NAMES = [
  "sshTarget",
  "sshName",
  "sshHost",
  "sshUser",
  "sshPort",
  "sshStrictHostKeyChecking",
] as const;

type HostKeyPolicy = SshProfileSaveInput["strictHostKeyChecking"];

export type SshUrlOpenRequest = {
  target: string;
  name: string;
  host: string;
  username: string;
  port?: number;
  strictHostKeyChecking: HostKeyPolicy;
};

export type SshUrlOpenResult = {
  profile: SshProfile;
  created: boolean;
};

export async function consumeSshUrlOpenRequest(): Promise<SshUrlOpenResult | undefined> {
  const request = parseSshUrlOpenRequest(new URLSearchParams(window.location.search));
  if (!request) return undefined;

  const [profiles, configHosts] = await Promise.all([
    fetchSshProfiles(),
    fetchSshConfigHosts().catch((): SshConfigHost[] => []),
  ]);
  const input = profileInputFromUrlRequest(request, configHosts);
  const reusable = reusableOpenSshProfile(profiles, input);
  if (reusable?.enabled) {
    return { profile: reusable, created: false };
  }

  const profile = await saveSshProfile({
    ...input,
    id: reusable?.id,
    name: reusable?.name.trim() || input.name,
    enabled: true,
  });
  return { profile, created: !reusable };
}

export function replaceSshUrlOpenParams(selector: string) {
  const url = new URL(window.location.href);
  for (const name of SSH_URL_PARAM_NAMES) {
    url.searchParams.delete(name);
  }
  url.searchParams.set("name", selector);
  url.searchParams.delete("tab");

  const state = window.history.state && typeof window.history.state === "object"
    ? window.history.state
    : {};
  const nextState: Record<string, unknown> = { ...state, name: selector };
  delete nextState.tab;
  window.history.replaceState(nextState, "", url);
}

export function hasSshUrlOpenRequest(): boolean {
  return new URLSearchParams(window.location.search).has("sshTarget");
}

function parseSshUrlOpenRequest(params: URLSearchParams): SshUrlOpenRequest | undefined {
  const target = normalizeSshToken(params.get("sshTarget"), "sshTarget", { required: true });
  if (!target) return undefined;

  const parsedTarget = parseTargetDisplay(target);
  const name = normalizeName(params.get("sshName")) || target;
  const host = normalizeSshToken(params.get("sshHost"), "sshHost") || parsedTarget.host;
  const username = normalizeSshUser(params.get("sshUser")) || parsedTarget.username;

  return {
    target,
    name,
    host,
    username,
    port: normalizePort(params.get("sshPort")),
    strictHostKeyChecking: normalizeHostKeyPolicy(params.get("sshStrictHostKeyChecking")),
  };
}

function profileInputFromUrlRequest(
  request: SshUrlOpenRequest,
  configHosts: SshConfigHost[],
): SshProfileSaveInput {
  const configHost = configHosts.find((host) => host.alias === request.target);
  return {
    name: request.name,
    kind: "device-openssh",
    enabled: true,
    target: request.target,
    host: request.host || configHost?.host || request.target,
    username: request.username || configHost?.username || "",
    port: request.port,
    strictHostKeyChecking: request.strictHostKeyChecking,
  };
}

function reusableOpenSshProfile(
  profiles: SshProfile[],
  input: SshProfileSaveInput,
): SshProfile | undefined {
  const target = input.target?.trim() ?? "";
  const port = profilePort(input);
  return profiles.find((profile) => {
    return profile.kind === "device-openssh"
      && profile.target.trim() === target
      && profilePort(profile) === port;
  });
}

function normalizeName(value: string | null): string {
  return String(value ?? "").trim().slice(0, 120);
}

function normalizeSshToken(
  value: string | null,
  field: string,
  options: { required?: boolean } = {},
): string {
  const token = String(value ?? "").trim();
  if (!token) {
    if (options.required) {
      throw new Error(`${field} is required`);
    }
    return "";
  }
  if (token.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(token)) {
    throw new Error(`${field} is invalid`);
  }
  return token;
}

function normalizeSshUser(value: string | null): string {
  const username = normalizeSshToken(value, "sshUser");
  if (username.includes("@")) {
    throw new Error("sshUser is invalid");
  }
  return username;
}

function normalizePort(value: string | null): number | undefined {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  if (!/^\d+$/.test(text)) {
    throw new Error("sshPort must be an integer from 1 to 65535");
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("sshPort must be an integer from 1 to 65535");
  }
  return port;
}

function normalizeHostKeyPolicy(value: string | null): HostKeyPolicy {
  switch (String(value ?? "").trim().toLowerCase()) {
    case "yes":
    case "strict":
      return "yes";
    case "no":
    case "off":
      return "no";
    case "accept-new":
    default:
      return "accept-new";
  }
}

function parseTargetDisplay(target: string): { username: string; host: string } {
  const separator = target.lastIndexOf("@");
  if (separator <= 0 || separator === target.length - 1) {
    return { username: "", host: "" };
  }
  const username = target.slice(0, separator);
  const host = target.slice(separator + 1);
  if (!username || !host || username.includes("@")) {
    return { username: "", host: "" };
  }
  return { username, host };
}

function profilePort(profile: { port?: number | null }): number | undefined {
  return typeof profile.port === "number" && Number.isFinite(profile.port)
    ? profile.port
    : undefined;
}
