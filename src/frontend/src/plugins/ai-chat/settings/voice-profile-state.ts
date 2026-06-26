import type { AiVoiceProviderProfile, AiVoiceSpeechProviderProfile, Settings } from "../../../types";
import {
  AI_VOICE_PROFILE_LIMIT,
  normalizeAiVoiceActiveProfileId,
  normalizeAiVoiceProviderProfiles,
  sanitizeAiVoiceProviderProfile,
} from "../voice-profiles";
import {
  AI_VOICE_REPLY_PROFILE_LIMIT,
  normalizeAiVoiceSpeechActiveProfileId,
  normalizeAiVoiceSpeechProviderProfiles,
  sanitizeAiVoiceSpeechProviderProfile,
} from "../voice-speech-profiles";

export function aiVoiceProviderProfileById(settings: Settings, profileId: string | undefined): AiVoiceProviderProfile | undefined {
  if (!profileId) return undefined;
  return settings.aiVoiceProviderProfiles.find((profile) => profile.id === profileId);
}

export function activeAiVoiceProviderProfile(settings: Settings): AiVoiceProviderProfile | undefined {
  return aiVoiceProviderProfileById(settings, settings.aiVoiceActiveProviderProfileId)
    ?? settings.aiVoiceProviderProfiles[0];
}

export function syncAiVoiceProviderProfiles(settings: Settings) {
  settings.aiVoiceProviderProfiles = normalizeAiVoiceProviderProfiles(settings.aiVoiceProviderProfiles)
    .slice(0, AI_VOICE_PROFILE_LIMIT);
  settings.aiVoiceActiveProviderProfileId = normalizeAiVoiceActiveProfileId(
    settings.aiVoiceActiveProviderProfileId,
    settings.aiVoiceProviderProfiles,
  );
}

export function upsertAiVoiceProviderProfile(settings: Settings, profile: AiVoiceProviderProfile) {
  const existingIndex = settings.aiVoiceProviderProfiles.findIndex((item) => item.id === profile.id);
  const sanitized = sanitizeAiVoiceProviderProfile(
    profile,
    existingIndex >= 0 ? existingIndex : settings.aiVoiceProviderProfiles.length,
  );
  const profiles = [...settings.aiVoiceProviderProfiles];
  if (existingIndex >= 0) {
    profiles[existingIndex] = sanitized;
  } else {
    profiles.push(sanitized);
  }
  settings.aiVoiceProviderProfiles = normalizeAiVoiceProviderProfiles(profiles);
  settings.aiVoiceActiveProviderProfileId = sanitized.id;
  syncAiVoiceProviderProfiles(settings);
}

export function selectAiVoiceProviderProfile(settings: Settings, profileId: string): boolean {
  if (!aiVoiceProviderProfileById(settings, profileId)) return false;
  settings.aiVoiceActiveProviderProfileId = profileId;
  syncAiVoiceProviderProfiles(settings);
  return true;
}

export function removeAiVoiceProviderProfile(settings: Settings, profileId: string): boolean {
  if (profileId === "mimo" || profileId === "mimo-token-plan") return false;
  const profiles = settings.aiVoiceProviderProfiles.filter((profile) => profile.id !== profileId);
  if (profiles.length === settings.aiVoiceProviderProfiles.length) return false;
  settings.aiVoiceProviderProfiles = profiles;
  if (settings.aiVoiceActiveProviderProfileId === profileId) {
    settings.aiVoiceActiveProviderProfileId = profiles[0]?.id ?? "";
  }
  syncAiVoiceProviderProfiles(settings);
  return true;
}

export function aiVoiceReplyProviderProfileById(settings: Settings, profileId: string | undefined): AiVoiceSpeechProviderProfile | undefined {
  if (!profileId) return undefined;
  return settings.aiVoiceReplyProviderProfiles.find((profile) => profile.id === profileId);
}

export function activeAiVoiceReplyProviderProfile(settings: Settings): AiVoiceSpeechProviderProfile | undefined {
  return aiVoiceReplyProviderProfileById(settings, settings.aiVoiceReplyActiveProviderProfileId)
    ?? settings.aiVoiceReplyProviderProfiles[0];
}

export function syncAiVoiceReplyProviderProfiles(settings: Settings) {
  settings.aiVoiceReplyProviderProfiles = normalizeAiVoiceSpeechProviderProfiles(settings.aiVoiceReplyProviderProfiles)
    .slice(0, AI_VOICE_REPLY_PROFILE_LIMIT);
  settings.aiVoiceReplyActiveProviderProfileId = normalizeAiVoiceSpeechActiveProfileId(
    settings.aiVoiceReplyActiveProviderProfileId,
    settings.aiVoiceReplyProviderProfiles,
  );
}

export function upsertAiVoiceReplyProviderProfile(settings: Settings, profile: AiVoiceSpeechProviderProfile) {
  const existingIndex = settings.aiVoiceReplyProviderProfiles.findIndex((item) => item.id === profile.id);
  const sanitized = sanitizeAiVoiceSpeechProviderProfile(
    profile,
    existingIndex >= 0 ? existingIndex : settings.aiVoiceReplyProviderProfiles.length,
  );
  const profiles = [...settings.aiVoiceReplyProviderProfiles];
  if (existingIndex >= 0) {
    profiles[existingIndex] = sanitized;
  } else {
    profiles.push(sanitized);
  }
  settings.aiVoiceReplyProviderProfiles = normalizeAiVoiceSpeechProviderProfiles(profiles);
  settings.aiVoiceReplyActiveProviderProfileId = sanitized.id;
  syncAiVoiceReplyProviderProfiles(settings);
}

export function selectAiVoiceReplyProviderProfile(settings: Settings, profileId: string): boolean {
  if (!aiVoiceReplyProviderProfileById(settings, profileId)) return false;
  settings.aiVoiceReplyActiveProviderProfileId = profileId;
  syncAiVoiceReplyProviderProfiles(settings);
  return true;
}

export function removeAiVoiceReplyProviderProfile(settings: Settings, profileId: string): boolean {
  if (profileId === "mimo" || profileId === "mimo-token-plan" || profileId === "openai-compatible") {
    return false;
  }
  const profiles = settings.aiVoiceReplyProviderProfiles.filter((profile) => profile.id !== profileId);
  if (profiles.length === settings.aiVoiceReplyProviderProfiles.length) return false;
  settings.aiVoiceReplyProviderProfiles = profiles;
  if (settings.aiVoiceReplyActiveProviderProfileId === profileId) {
    settings.aiVoiceReplyActiveProviderProfileId = profiles[0]?.id ?? "";
  }
  syncAiVoiceReplyProviderProfiles(settings);
  return true;
}
