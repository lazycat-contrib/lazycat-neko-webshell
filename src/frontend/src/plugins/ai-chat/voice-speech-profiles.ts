import type { AiVoiceProviderKind, AiVoiceSpeechEndpointType, AiVoiceSpeechProviderProfile } from "../../types";

export const AI_VOICE_REPLY_PROFILE_LIMIT = 12;
export const XIAOMI_MIMO_TTS_MODEL = "mimo-v2.5-tts";
export const OPENAI_SPEECH_MODEL = "gpt-4o-mini-tts";
export const DEFAULT_MIMO_SPEECH_VOICE = "mimo_default";
export const DEFAULT_OPENAI_SPEECH_VOICE = "alloy";
export const DEFAULT_SPEECH_FORMAT = "wav";
export const SPEECH_FORMATS = ["wav", "mp3", "opus", "aac", "flac", "pcm"] as const;

export const MIMO_SPEECH_VOICE_PRESETS = [
  { value: "mimo_default", label: "MiMo-default", meta: "中文/English" },
  { value: "冰糖", label: "冰糖", meta: "中文 · 女声" },
  { value: "茉莉", label: "茉莉", meta: "中文 · 女声" },
  { value: "苏打", label: "苏打", meta: "中文 · 男声" },
  { value: "白桦", label: "白桦", meta: "中文 · 男声" },
  { value: "Mia", label: "Mia", meta: "English · female" },
  { value: "Chloe", label: "Chloe", meta: "English · female" },
  { value: "Milo", label: "Milo", meta: "English · male" },
  { value: "Dean", label: "Dean", meta: "English · male" },
] as const;

export const OPENAI_SPEECH_VOICE_PRESETS = [
  { value: "alloy", label: "alloy", meta: "" },
  { value: "ash", label: "ash", meta: "" },
  { value: "ballad", label: "ballad", meta: "" },
  { value: "coral", label: "coral", meta: "" },
  { value: "echo", label: "echo", meta: "" },
  { value: "fable", label: "fable", meta: "" },
  { value: "onyx", label: "onyx", meta: "" },
  { value: "nova", label: "nova", meta: "" },
  { value: "sage", label: "sage", meta: "" },
  { value: "shimmer", label: "shimmer", meta: "" },
  { value: "verse", label: "verse", meta: "" },
  { value: "marin", label: "marin", meta: "" },
  { value: "cedar", label: "cedar", meta: "" },
] as const;

export function defaultAiVoiceSpeechProviderProfiles(): AiVoiceSpeechProviderProfile[] {
  return [
    {
      id: "mimo",
      name: "Xiaomi Mimo",
      provider: "mimo",
      endpointType: "chat-audio",
      baseUrl: "https://api.xiaomimimo.com/v1",
      apiKey: "",
      model: XIAOMI_MIMO_TTS_MODEL,
      voice: DEFAULT_MIMO_SPEECH_VOICE,
      format: DEFAULT_SPEECH_FORMAT,
      instructions: "用自然、清晰的语气朗读。",
    },
    {
      id: "mimo-token-plan",
      name: "Xiaomi Mimo Token Plan",
      provider: "mimo-token-plan",
      endpointType: "chat-audio",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
      apiKey: "",
      model: XIAOMI_MIMO_TTS_MODEL,
      voice: DEFAULT_MIMO_SPEECH_VOICE,
      format: DEFAULT_SPEECH_FORMAT,
      instructions: "用自然、清晰的语气朗读。",
    },
    {
      id: "openai-compatible",
      name: "OpenAI compatible",
      provider: "openai-compatible",
      endpointType: "audio-speech",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: OPENAI_SPEECH_MODEL,
      voice: DEFAULT_OPENAI_SPEECH_VOICE,
      format: DEFAULT_SPEECH_FORMAT,
      instructions: "",
    },
  ];
}

export function newAiVoiceSpeechProviderProfile(index: number, id = newVoiceSpeechProfileId()): AiVoiceSpeechProviderProfile {
  return sanitizeAiVoiceSpeechProviderProfile({
    id,
    name: `Voice Reply Provider ${index + 1}`,
    provider: "openai-compatible",
    endpointType: "audio-speech",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: OPENAI_SPEECH_MODEL,
    voice: DEFAULT_OPENAI_SPEECH_VOICE,
    format: DEFAULT_SPEECH_FORMAT,
    instructions: "",
  }, index);
}

export function normalizeAiVoiceSpeechProviderProfiles(value: unknown): AiVoiceSpeechProviderProfile[] {
  const defaults = defaultAiVoiceSpeechProviderProfiles();
  const profiles = defaults.map((profile, index) => sanitizeAiVoiceSpeechProviderProfile(profile, index));
  const source = Array.isArray(value) ? value : [];
  for (const item of source) {
    if (!item || typeof item !== "object") continue;
    const profile = sanitizeAiVoiceSpeechProviderProfile(item as Partial<AiVoiceSpeechProviderProfile>, profiles.length);
    const index = profiles.findIndex((existing) => existing.id === profile.id);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
  }
  return profiles.slice(0, AI_VOICE_REPLY_PROFILE_LIMIT);
}

export function normalizeAiVoiceSpeechActiveProfileId(value: unknown, profiles: AiVoiceSpeechProviderProfile[]): string {
  const id = typeof value === "string" ? value : "";
  if (profiles.some((profile) => profile.id === id)) return id;
  return profiles[0]?.id ?? "";
}

export function sanitizeAiVoiceSpeechProviderProfile(
  profile: Partial<AiVoiceSpeechProviderProfile>,
  index: number,
): AiVoiceSpeechProviderProfile {
  const provider = normalizeProviderKind(profile.provider);
  const endpointType = provider === "openai-compatible"
    ? normalizeSpeechEndpointType(profile.endpointType)
    : "chat-audio";
  const baseUrl = sanitizeSpeechBaseUrl(profile.baseUrl, provider);
  return {
    id: sanitizeSpeechProfileId(profile.id, index),
    name: sanitizeSpeechProfileName(profile.name, provider, index),
    provider,
    endpointType,
    baseUrl,
    apiKey: typeof profile.apiKey === "string" ? profile.apiKey : "",
    model: sanitizeSpeechModel(profile.model, endpointType),
    voice: sanitizeSpeechVoice(profile.voice, endpointType),
    format: sanitizeSpeechFormat(profile.format),
    instructions: sanitizeSpeechInstructions(profile.instructions),
  };
}

export function aiVoiceSpeechProfileConfigured(profile: AiVoiceSpeechProviderProfile | undefined): boolean {
  return Boolean(profile?.baseUrl.trim() && profile.apiKey.trim() && profile.model.trim() && profile.voice.trim());
}

export function isBuiltinAiVoiceSpeechProfile(profileId: string): boolean {
  return profileId === "mimo" || profileId === "mimo-token-plan" || profileId === "openai-compatible";
}

export function speechVoicePresets(profile: Pick<AiVoiceSpeechProviderProfile, "provider" | "endpointType">) {
  return profile.provider === "mimo" || profile.provider === "mimo-token-plan" || profile.endpointType === "chat-audio"
    ? MIMO_SPEECH_VOICE_PRESETS
    : OPENAI_SPEECH_VOICE_PRESETS;
}

function normalizeProviderKind(value: unknown): AiVoiceProviderKind {
  if (value === "mimo" || value === "mimo-token-plan") return value;
  return "openai-compatible";
}

function normalizeSpeechEndpointType(value: unknown): AiVoiceSpeechEndpointType {
  return value === "chat-audio" ? "chat-audio" : "audio-speech";
}

function sanitizeSpeechProfileId(value: unknown, index: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  const sanitized = raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64);
  return sanitized || `voice-reply-provider-${index + 1}`;
}

function sanitizeSpeechProfileName(value: unknown, provider: AiVoiceProviderKind, index: number): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 48);
  if (provider === "mimo") return "Xiaomi Mimo";
  if (provider === "mimo-token-plan") return "Xiaomi Mimo Token Plan";
  return `Voice Reply Provider ${index + 1}`;
}

function sanitizeSpeechBaseUrl(value: unknown, provider: AiVoiceProviderKind): string {
  const raw = typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
  if (raw) return raw;
  if (provider === "mimo") return "https://api.xiaomimimo.com/v1";
  if (provider === "mimo-token-plan") return "https://token-plan-cn.xiaomimimo.com/v1";
  return "https://api.openai.com/v1";
}

function sanitizeSpeechModel(value: unknown, endpointType: AiVoiceSpeechEndpointType): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw;
  return endpointType === "chat-audio" ? XIAOMI_MIMO_TTS_MODEL : OPENAI_SPEECH_MODEL;
}

function sanitizeSpeechVoice(value: unknown, endpointType: AiVoiceSpeechEndpointType): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw) return raw.slice(0, 64);
  return endpointType === "chat-audio" ? DEFAULT_MIMO_SPEECH_VOICE : DEFAULT_OPENAI_SPEECH_VOICE;
}

function sanitizeSpeechFormat(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (SPEECH_FORMATS as readonly string[]).includes(raw) ? raw : DEFAULT_SPEECH_FORMAT;
}

function sanitizeSpeechInstructions(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 1000) : "";
}

function newVoiceSpeechProfileId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `voice-reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
