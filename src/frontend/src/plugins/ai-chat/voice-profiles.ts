import type { AiVoiceEndpointType, AiVoiceProviderKind, AiVoiceProviderProfile } from "../../types";

export const AI_VOICE_PROFILE_LIMIT = 12;
export const XIAOMI_MIMO_API_BASE = "https://api.xiaomimimo.com/v1";
export const XIAOMI_MIMO_TOKEN_PLAN_API_BASE = "https://token-plan-cn.xiaomimimo.com/v1";
export const XIAOMI_MIMO_MODEL = "mimo-v2.5-asr";
export const OPENAI_TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";

export function defaultAiVoiceProviderProfiles(): AiVoiceProviderProfile[] {
  return [
    {
      id: "mimo",
      name: "Xiaomi Mimo",
      provider: "mimo",
      endpointType: "chat-input-audio",
      baseUrl: XIAOMI_MIMO_API_BASE,
      apiKey: "",
      model: XIAOMI_MIMO_MODEL,
      language: "zh",
    },
    {
      id: "mimo-token-plan",
      name: "Xiaomi Mimo Token Plan",
      provider: "mimo-token-plan",
      endpointType: "chat-input-audio",
      baseUrl: XIAOMI_MIMO_TOKEN_PLAN_API_BASE,
      apiKey: "",
      model: XIAOMI_MIMO_MODEL,
      language: "zh",
    },
  ];
}

export function newAiVoiceProviderProfile(index: number, id = newVoiceProfileId()): AiVoiceProviderProfile {
  return sanitizeAiVoiceProviderProfile({
    id,
    name: `Voice Provider ${index + 1}`,
    provider: "openai-compatible",
    endpointType: "audio-transcriptions",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: OPENAI_TRANSCRIBE_MODEL,
    language: "auto",
  }, index);
}

export function normalizeAiVoiceProviderProfiles(value: unknown): AiVoiceProviderProfile[] {
  const defaults = defaultAiVoiceProviderProfiles();
  const profiles = defaults.map((profile, index) => sanitizeAiVoiceProviderProfile(profile, index));
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const profile = sanitizeAiVoiceProviderProfile(item as Partial<AiVoiceProviderProfile>, profiles.length);
    const index = profiles.findIndex((existing) => existing.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
  }
  return profiles.slice(0, AI_VOICE_PROFILE_LIMIT);
}

export function normalizeAiVoiceActiveProfileId(value: unknown, profiles: AiVoiceProviderProfile[]): string {
  const id = typeof value === "string" ? value : "";
  if (profiles.some((profile) => profile.id === id)) return id;
  return profiles[0]?.id ?? "";
}

export function sanitizeAiVoiceProviderProfile(
  profile: Partial<AiVoiceProviderProfile>,
  index: number,
): AiVoiceProviderProfile {
  const provider = normalizeAiVoiceProviderKind(profile.provider);
  const endpointType = provider === "openai-compatible"
    ? normalizeAiVoiceEndpointType(profile.endpointType)
    : "chat-input-audio";
  const baseUrl = sanitizeVoiceBaseUrl(profile.baseUrl, provider);
  return {
    id: sanitizeVoiceProfileId(profile.id, index),
    name: sanitizeVoiceProfileName(profile.name, provider, index),
    provider,
    endpointType,
    baseUrl,
    apiKey: typeof profile.apiKey === "string" ? profile.apiKey : "",
    model: sanitizeVoiceModel(profile.model, endpointType),
    language: sanitizeVoiceLanguage(profile.language, provider),
  };
}

export function aiVoiceProviderLabel(provider: AiVoiceProviderKind): string {
  if (provider === "mimo") return "Xiaomi Mimo";
  if (provider === "mimo-token-plan") return "Xiaomi Mimo Token Plan";
  return "OpenAI compatible";
}

export function aiVoiceEndpointLabel(endpointType: AiVoiceEndpointType): string {
  return endpointType === "chat-input-audio"
    ? "Chat input_audio"
    : "Audio transcriptions";
}

export function aiVoiceProfileConfigured(profile: AiVoiceProviderProfile | undefined): boolean {
  return Boolean(profile?.baseUrl.trim() && profile.apiKey.trim() && profile.model.trim());
}

export function isBuiltinAiVoiceProfile(profileId: string): boolean {
  return profileId === "mimo" || profileId === "mimo-token-plan";
}

function normalizeAiVoiceProviderKind(value: unknown): AiVoiceProviderKind {
  if (value === "mimo" || value === "mimo-token-plan") return value;
  return "openai-compatible";
}

function normalizeAiVoiceEndpointType(value: unknown): AiVoiceEndpointType {
  return value === "chat-input-audio" ? "chat-input-audio" : "audio-transcriptions";
}

function sanitizeVoiceProfileId(value: unknown, index: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return sanitized || `voice-provider-${index + 1}`;
}

function sanitizeVoiceProfileName(value: unknown, provider: AiVoiceProviderKind, index: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 48);
  if (provider === "mimo") return "Xiaomi Mimo";
  if (provider === "mimo-token-plan") return "Xiaomi Mimo Token Plan";
  return `Voice Provider ${index + 1}`;
}

function sanitizeVoiceBaseUrl(value: unknown, provider: AiVoiceProviderKind): string {
  const raw = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (raw) return raw;
  if (provider === "mimo") return XIAOMI_MIMO_API_BASE;
  if (provider === "mimo-token-plan") return XIAOMI_MIMO_TOKEN_PLAN_API_BASE;
  return "https://api.openai.com/v1";
}

function sanitizeVoiceModel(value: unknown, endpointType: AiVoiceEndpointType): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw;
  return endpointType === "chat-input-audio" ? XIAOMI_MIMO_MODEL : OPENAI_TRANSCRIBE_MODEL;
}

function sanitizeVoiceLanguage(value: unknown, provider: AiVoiceProviderKind): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 24);
  return provider === "openai-compatible" ? "auto" : "zh";
}

function newVoiceProfileId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `voice-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
