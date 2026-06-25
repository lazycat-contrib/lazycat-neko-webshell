import type { JsonRecord } from "../../types";
import { boolValue, numberValue, stringValue } from "../../network-plugin-data";
import type { TunnelProviderProfileEditor, TunnelProviderProfileSummary } from "./types";

const NGROK_PROVIDER = "ngrok";
const NGROK_PROVIDER_PREFIX = "ngrok:";
const QUICK_TUNNEL_PROVIDER = "cloudflare-quick";

export type TunnelProfileDialogState = {
  profileId: string;
  isNew: boolean;
};

export type TunnelProviderProfileSaveInput = {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  authtoken: string;
};

export function parseTunnelProviderProfiles(raw: string | undefined): TunnelProviderProfileSummary[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseTunnelProviderProfile).filter((profile): profile is TunnelProviderProfileSummary => Boolean(profile));
  } catch {
    return [];
  }
}

export function tunnelProfileEditor(
  dialog: TunnelProfileDialogState,
  profiles: TunnelProviderProfileSummary[],
): TunnelProviderProfileEditor {
  if (dialog.isNew) {
    return {
      id: dialog.profileId,
      provider: NGROK_PROVIDER,
      name: "",
      enabled: true,
      configured: false,
      authtoken: "",
    };
  }
  const profile = profiles.find((item) => item.id === dialog.profileId);
  return {
    id: dialog.profileId,
    provider: NGROK_PROVIDER,
    name: profile?.name ?? "",
    enabled: profile?.enabled ?? true,
    configured: profile?.configured ?? false,
    authtoken: "",
  };
}

export function syncedPublicTunnelProvider(provider: string, profiles: TunnelProviderProfileSummary[]): string {
  if (!provider.startsWith(NGROK_PROVIDER_PREFIX)) return provider || QUICK_TUNNEL_PROVIDER;
  const profileId = provider.slice(NGROK_PROVIDER_PREFIX.length);
  const available = profiles.some((profile) => profile.id === profileId && profile.enabled && profile.configured);
  return available ? provider : QUICK_TUNNEL_PROVIDER;
}

export function publicTunnelProviderMetadata(
  provider: string,
  profiles: TunnelProviderProfileSummary[],
): Record<string, string> | undefined {
  if (!provider.startsWith(NGROK_PROVIDER_PREFIX)) {
    return { provider: QUICK_TUNNEL_PROVIDER };
  }
  const profileId = provider.slice(NGROK_PROVIDER_PREFIX.length);
  const profile = profiles.find((item) => item.id === profileId && item.enabled && item.configured);
  if (!profile) return undefined;
  return {
    provider: NGROK_PROVIDER,
    ngrokProfileId: profile.id,
  };
}

export function tunnelProfileSaveInputFromSummary(
  profile: TunnelProviderProfileSummary,
): TunnelProviderProfileSaveInput {
  return {
    id: profile.id,
    provider: profile.provider,
    name: profile.name,
    enabled: profile.enabled,
    authtoken: "",
  };
}

function parseTunnelProviderProfile(item: unknown): TunnelProviderProfileSummary | undefined {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const record = item as JsonRecord;
  const id = stringValue(record, "id");
  const provider = stringValue(record, "provider");
  const name = stringValue(record, "name");
  if (!id || provider !== NGROK_PROVIDER || !name) return undefined;
  return {
    id,
    provider,
    name,
    enabled: boolValue(record, "enabled"),
    configured: boolValue(record, "configured"),
    createdAtMs: numberValue(record, "createdAtMs"),
    updatedAtMs: numberValue(record, "updatedAtMs"),
    lastUsedAtMs: numberValue(record, "lastUsedAtMs"),
  };
}
