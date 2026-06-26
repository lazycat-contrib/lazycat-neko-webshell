import type { MessageKey } from "../../i18n";
import type { Settings, Tone } from "../../types";
import { errorMessage } from "../../utils";
import {
  createVoiceSpeechAudioSource,
  fetchVoiceSpeechAudio,
  releaseAudioElement,
} from "./voice-audio";
import { aiVoiceSpeechProfileConfigured } from "./voice-speech-profiles";

const TEST_SPEECH_TEXT = "你好，这是一段语音回复测试。";

export type AiVoiceSpeechTestStatus = "idle" | "loading" | "ready" | "error";

export type AiVoiceSpeechTestState = {
  status: AiVoiceSpeechTestStatus;
  objectUrl?: string;
  contentType?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  error?: string;
};

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function createAiVoiceSpeechTestController(options: {
  settings: () => Settings;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
}) {
  let state: AiVoiceSpeechTestState = { status: "idle" };

  function viewState(): AiVoiceSpeechTestState {
    return state;
  }

  async function run() {
    const settings = options.settings();
    const profile = settings.aiVoiceReplyProviderProfiles.find(
      (item) => item.id === settings.aiVoiceReplyActiveProviderProfileId,
    ) ?? settings.aiVoiceReplyProviderProfiles[0];
    if (!aiVoiceSpeechProfileConfigured(profile)) {
      clearObjectUrl();
      state = {
        status: "error",
        error: options.tr("ai.voiceReplyNotConfigured"),
      };
      options.onStatus(options.tr("ai.voiceReplyNotConfigured"), "error");
      options.onRender();
      return;
    }
    clearObjectUrl();
    state = { status: "loading" };
    options.onRender();
    try {
      const source = await createVoiceSpeechAudioSource(await fetchVoiceSpeechAudio(TEST_SPEECH_TEXT, { test: true }));
      releaseAudioElement(source.audio);
      state = {
        status: "ready",
        objectUrl: source.objectUrl,
        contentType: source.contentType,
        sizeBytes: source.sizeBytes,
        durationSeconds: source.durationSeconds,
      };
      options.onStatus(options.tr("status.aiVoiceReplyTestReady"), "ok");
    } catch (error) {
      clearObjectUrl();
      state = {
        status: "error",
        error: errorMessage(error),
      };
      options.onStatus(options.tr("status.aiVoiceReplyFailed", { message: errorMessage(error) }), "error");
    } finally {
      options.onRender();
    }
  }

  function reset() {
    clearObjectUrl();
    state = { status: "idle" };
    options.onRender();
  }

  function clearObjectUrl() {
    if (state.objectUrl) {
      URL.revokeObjectURL(state.objectUrl);
    }
  }

  return {
    viewState,
    run,
    reset,
  };
}
