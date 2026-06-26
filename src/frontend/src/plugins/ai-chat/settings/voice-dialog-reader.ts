import type {
  AiVoiceProviderProfile,
  AiVoiceSpeechEndpointType,
  AiVoiceSpeechProviderProfile,
} from "../../../types";
import {
  sanitizeAiVoiceProviderProfile,
  XIAOMI_MIMO_API_BASE,
  XIAOMI_MIMO_MODEL,
  XIAOMI_MIMO_TOKEN_PLAN_API_BASE,
} from "../voice-profiles";
import {
  OPENAI_SPEECH_MODEL,
  sanitizeAiVoiceSpeechProviderProfile,
  XIAOMI_MIMO_TTS_MODEL,
} from "../voice-speech-profiles";

type FieldReader = (field: string) => string;

export function readAiVoiceProviderProfileFromFields(options: {
  read: FieldReader;
  existing: AiVoiceProviderProfile | undefined;
  isNew: boolean;
  profileId: string | undefined;
  profileCount: number;
}): AiVoiceProviderProfile {
  const provider = options.read("voiceProvider");
  const profileId = options.existing?.id ?? options.profileId ?? "";
  const fallbackName = options.existing?.name
    || (options.isNew ? `Voice Provider ${options.profileCount + 1}` : "Voice Provider");
  const endpointType = provider === "mimo" || provider === "mimo-token-plan"
    ? "chat-input-audio"
    : options.read("voiceEndpointType");
  const baseUrl = provider === "mimo"
    ? XIAOMI_MIMO_API_BASE
    : provider === "mimo-token-plan"
      ? XIAOMI_MIMO_TOKEN_PLAN_API_BASE
      : options.read("voiceBaseUrl").trim();
  const model = options.read("voiceModel").trim()
    || (endpointType === "chat-input-audio" ? XIAOMI_MIMO_MODEL : "gpt-4o-mini-transcribe");
  return sanitizeAiVoiceProviderProfile({
    id: profileId,
    name: options.read("voiceName").trim() || fallbackName,
    provider: provider === "mimo" || provider === "mimo-token-plan" ? provider : "openai-compatible",
    endpointType: endpointType === "chat-input-audio" ? "chat-input-audio" : "audio-transcriptions",
    baseUrl,
    apiKey: options.read("voiceApiKey"),
    model,
    language: options.read("voiceLanguage").trim(),
  }, options.profileCount);
}

export function readAiVoiceReplyProviderProfileFromFields(options: {
  read: FieldReader;
  existing: AiVoiceSpeechProviderProfile | undefined;
  isNew: boolean;
  profileId: string | undefined;
  profileCount: number;
}): AiVoiceSpeechProviderProfile {
  const provider = options.read("voiceReplyProvider");
  const profileId = options.existing?.id ?? options.profileId ?? "";
  const fallbackName = options.existing?.name
    || (options.isNew ? `Voice Reply Provider ${options.profileCount + 1}` : "Voice Reply Provider");
  const endpointType: AiVoiceSpeechEndpointType = provider === "mimo" || provider === "mimo-token-plan"
    ? "chat-audio"
    : options.read("voiceReplyEndpointType") === "chat-audio" ? "chat-audio" : "audio-speech";
  const baseUrl = provider === "mimo"
    ? XIAOMI_MIMO_API_BASE
    : provider === "mimo-token-plan"
      ? XIAOMI_MIMO_TOKEN_PLAN_API_BASE
      : options.read("voiceReplyBaseUrl").trim();
  const model = options.read("voiceReplyModel").trim()
    || (endpointType === "chat-audio" ? XIAOMI_MIMO_TTS_MODEL : OPENAI_SPEECH_MODEL);
  return sanitizeAiVoiceSpeechProviderProfile({
    id: profileId,
    name: options.read("voiceReplyName").trim() || fallbackName,
    provider: provider === "mimo" || provider === "mimo-token-plan" ? provider : "openai-compatible",
    endpointType,
    baseUrl,
    apiKey: options.read("voiceReplyApiKey"),
    model,
    voice: options.read("voiceReplyVoice").trim(),
    format: options.read("voiceReplyFormat").trim(),
    instructions: options.read("voiceReplyInstructions").trim(),
  }, options.profileCount);
}
