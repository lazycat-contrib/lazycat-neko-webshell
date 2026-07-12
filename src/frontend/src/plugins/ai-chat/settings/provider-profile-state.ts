import type { AiProviderProfile, Settings } from "../../../types";

export const MAX_AI_PROVIDER_PROFILES = 12;
export const DEFAULT_AI_PROVIDER = "openai-compatible";

export function normalizeAiProviderValue(value: string): string {
  return value === "openai-responses" || value === "anthropic"
    ? value
    : DEFAULT_AI_PROVIDER;
}

export function aiProviderProfileById(
  settings: Settings,
  profileId: string | undefined,
): AiProviderProfile | undefined {
  if (!profileId) return undefined;
  return settings.aiProviderProfiles.find((profile) => profile.id === profileId);
}

export function activeAiProviderProfile(settings: Settings): AiProviderProfile | undefined {
  return aiProviderProfileById(settings, settings.aiActiveProviderProfileId)
    ?? settings.aiProviderProfiles[0];
}

export function newAiProviderProfile(settings: Settings, profileId: string): AiProviderProfile {
  return {
    id: profileId,
    name: `Provider ${settings.aiProviderProfiles.length + 1}`,
    provider: DEFAULT_AI_PROVIDER,
    baseUrl: "",
    apiKey: "",
    model: "",
  };
}

export function sanitizeAiProviderProfile(
  profile: AiProviderProfile,
  index: number,
): AiProviderProfile {
  return {
    id: profile.id.trim() || (index === 0 ? "default" : `provider-${index + 1}`),
    name: profile.name.trim().slice(0, 48) || `Provider ${index + 1}`,
    provider: normalizeAiProviderValue(profile.provider),
    baseUrl: profile.baseUrl.trim(),
    apiKey: profile.apiKey,
    model: profile.model.trim(),
  };
}

export function syncActiveAiProviderProfile(settings: Settings) {
  settings.aiProviderProfiles = settings.aiProviderProfiles
    .slice(0, MAX_AI_PROVIDER_PROFILES)
    .map((profile, index) => sanitizeAiProviderProfile(profile, index));
  const activeProfile = activeAiProviderProfile(settings);
  settings.aiActiveProviderProfileId = activeProfile?.id ?? "";
  settings.aiProvider = activeProfile?.provider ?? DEFAULT_AI_PROVIDER;
  settings.aiBaseUrl = activeProfile?.baseUrl ?? "";
  settings.aiApiKey = activeProfile?.apiKey ?? "";
  settings.aiModel = activeProfile?.model ?? "";
}

export function updateActiveAiProviderProfile(
  settings: Settings,
  patch: Partial<Omit<AiProviderProfile, "id">>,
) {
  const activeProfile = activeAiProviderProfile(settings) ?? {
    id: settings.aiActiveProviderProfileId || "default",
    name: "Default",
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
  };
  const nextProfile = sanitizeAiProviderProfile({ ...activeProfile, ...patch }, 0);
  const profiles = settings.aiProviderProfiles.length
    ? [...settings.aiProviderProfiles]
    : [activeProfile];
  const existingIndex = profiles.findIndex((profile) => profile.id === activeProfile.id);
  if (existingIndex >= 0) {
    profiles[existingIndex] = nextProfile;
  } else {
    profiles.unshift(nextProfile);
  }
  settings.aiProviderProfiles = profiles;
  settings.aiActiveProviderProfileId = nextProfile.id;
  syncActiveAiProviderProfile(settings);
}

export function upsertAiProviderProfile(settings: Settings, profile: AiProviderProfile) {
  const existingIndex = settings.aiProviderProfiles.findIndex((item) => item.id === profile.id);
  const sanitized = sanitizeAiProviderProfile(
    profile,
    existingIndex >= 0 ? existingIndex : settings.aiProviderProfiles.length,
  );
  const profiles = [...settings.aiProviderProfiles];
  if (existingIndex >= 0) {
    profiles[existingIndex] = sanitized;
  } else {
    profiles.push(sanitized);
  }
  settings.aiProviderProfiles = profiles.slice(0, MAX_AI_PROVIDER_PROFILES);
  settings.aiActiveProviderProfileId = sanitized.id;
  syncActiveAiProviderProfile(settings);
}

export function selectAiProviderProfile(settings: Settings, profileId: string): boolean {
  if (!aiProviderProfileById(settings, profileId)) return false;
  settings.aiActiveProviderProfileId = profileId;
  syncActiveAiProviderProfile(settings);
  return true;
}

export function removeAiProviderProfile(settings: Settings, profileId: string): boolean {
  if (settings.aiProviderProfiles.length <= 1) return false;
  const nextProfiles = settings.aiProviderProfiles.filter((profile) => profile.id !== profileId);
  if (nextProfiles.length === settings.aiProviderProfiles.length) return false;
  settings.aiProviderProfiles = nextProfiles;
  if (settings.aiActiveProviderProfileId === profileId) {
    settings.aiActiveProviderProfileId = nextProfiles[0]?.id ?? "";
  }
  syncActiveAiProviderProfile(settings);
  return true;
}

export function aiProviderConnectionChanged(
  previous: AiProviderProfile,
  next: AiProviderProfile,
): boolean {
  return previous.provider !== next.provider
    || previous.baseUrl !== next.baseUrl
    || previous.apiKey !== next.apiKey;
}
