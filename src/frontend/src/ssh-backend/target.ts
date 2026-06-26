import {
  fetchSshConfigHosts,
  fetchSshProfiles,
  saveSshProfile,
  type SshConfigHost,
  type SshProfile,
  type SshProfileSaveInput,
} from "./api";

export type SshTargetDisplay = {
  username: string;
  host: string;
};

export function normalizeSshTarget(value: string): string {
  const target = value.trim();
  if (!target) {
    throw new Error("SSH target is required");
  }
  if (target.startsWith("-") || /[\s\x00-\x1f\x7f]/.test(target)) {
    throw new Error("Invalid SSH target");
  }
  return target;
}

export function sshCommandForTarget(value: string): string {
  const target = normalizeSshTarget(value);
  return `ssh ${shellQuote(target)}\n`;
}

export async function openOrCreateOpenSshProfile(value: string): Promise<SshProfile> {
  const target = normalizeSshTarget(value);
  const [profiles, configHosts] = await Promise.all([
    fetchSshProfiles(),
    fetchSshConfigHosts().catch((): SshConfigHost[] => []),
  ]);
  const input = profileInputFromTarget(target, configHosts);
  const reusable = reusableOpenSshProfile(profiles, input);
  if (reusable?.enabled) {
    return reusable;
  }
  return saveSshProfile({
    ...input,
    id: reusable?.id,
    name: reusable?.name.trim() || input.name,
    enabled: true,
  });
}

function profileInputFromTarget(target: string, configHosts: SshConfigHost[]): SshProfileSaveInput {
  const configHost = configHosts.find((host) => host.alias === target);
  const parsed = parseTargetDisplay(target);
  return {
    name: target,
    kind: "device-openssh",
    enabled: true,
    target,
    host: configHost?.host || parsed.host || target,
    username: configHost?.username || parsed.username,
    strictHostKeyChecking: "accept-new",
  };
}

function reusableOpenSshProfile(
  profiles: SshProfile[],
  input: SshProfileSaveInput,
): SshProfile | undefined {
  const target = input.target?.trim() ?? "";
  return profiles.find((profile) => (
    profile.kind === "device-openssh"
    && profile.target.trim() === target
    && profilePort(profile) === profilePort(input)
  ));
}

function profilePort(profile: { port?: number | null }): number | undefined {
  return typeof profile.port === "number" && Number.isFinite(profile.port)
    ? profile.port
    : undefined;
}

function parseTargetDisplay(target: string): SshTargetDisplay {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
