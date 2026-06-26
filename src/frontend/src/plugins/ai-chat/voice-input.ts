import type { MessageKey } from "../../i18n";
import type { Settings, TerminalPane, Tone } from "../../types";
import { errorMessage, escapeAttr } from "../../utils";
import { aiVoiceProfileConfigured } from "./voice-profiles";

const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
const VOICE_TRANSCRIPTION_ENDPOINT = "./api/ai/voice/transcriptions";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type AiVoiceInputController = {
  render: () => void;
};

export function createAiVoiceInputController(options: {
  root: HTMLDivElement;
  settings: () => Settings;
  isAiChatPluginEnabled: () => boolean;
  activePane: () => TerminalPane | undefined;
  sendText: (pane: TerminalPane, text: string) => boolean;
  focusTerminal: () => void;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  updateIcons: () => void;
}): AiVoiceInputController {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];
  let paneAtStart: TerminalPane | undefined;
  let stopAsCancel = false;
  let starting = false;
  let pendingStop: boolean | undefined;
  let uploading = false;

  function render() {
    const settings = options.settings();
    const activeProfile = settings.aiVoiceProviderProfiles.find((profile) => profile.id === settings.aiVoiceActiveProviderProfileId)
      ?? settings.aiVoiceProviderProfiles[0];
    const shouldShow = Boolean(
      settings.aiVoiceInputEnabled
      && options.isAiChatPluginEnabled()
      && options.activePane()
      && mediaRecorderAvailable(),
    );
    if (!shouldShow) {
      if (recorder && recorder.state !== "inactive") {
        stopRecording(true);
      }
      options.root.hidden = true;
      options.root.replaceChildren();
      return;
    }
    if (!options.root.firstElementChild) {
      options.root.innerHTML = `
        <button class="ai-voice-input-button" type="button" aria-label="${escapeAttr(options.tr("action.aiVoiceHold"))}" title="${escapeAttr(options.tr("action.aiVoiceHold"))}">
          <i data-lucide="mic"></i>
        </button>
      `;
      const button = options.root.querySelector<HTMLButtonElement>(".ai-voice-input-button");
      button?.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (button.disabled) return;
        try {
          button.setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort on older mobile browsers.
        }
        void startRecording();
      });
      button?.addEventListener("pointerup", (event) => {
        event.preventDefault();
        stopRecording(false);
      });
      button?.addEventListener("pointercancel", (event) => {
        event.preventDefault();
        stopRecording(true);
      });
      button?.addEventListener("lostpointercapture", () => {
        stopRecording(false);
      });
      button?.addEventListener("contextmenu", (event) => event.preventDefault());
    }
    const button = options.root.querySelector<HTMLButtonElement>(".ai-voice-input-button");
    if (button) {
      const configured = aiVoiceProfileConfigured(activeProfile);
      button.disabled = uploading || !configured;
      button.dataset.state = recorder && recorder.state !== "inactive"
        ? "recording"
        : uploading ? "uploading" : configured ? "idle" : "unconfigured";
      const title = configured
        ? options.tr("action.aiVoiceHold")
        : options.tr("ai.voiceNotConfigured");
      button.setAttribute("aria-label", title);
      button.title = title;
    }
    options.root.hidden = false;
    options.updateIcons();
  }

  async function startRecording() {
    if (starting || recorder || uploading) return;
    const pane = options.activePane();
    if (!pane) return;
    paneAtStart = pane;
    starting = true;
    pendingStop = undefined;
    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream = mediaStream;
      chunks = [];
      stopAsCancel = false;
      recorder = new MediaRecorder(mediaStream, mediaRecorderOptions());
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      });
      recorder.addEventListener("stop", () => {
        void finishRecording(stopAsCancel);
      }, { once: true });
      recorder.start();
      options.onStatus(options.tr("status.aiVoiceRecording"), "neutral");
      starting = false;
      if (pendingStop !== undefined) {
        const cancel = pendingStop;
        pendingStop = undefined;
        stopRecording(cancel);
      }
      render();
    } catch (error) {
      starting = false;
      pendingStop = undefined;
      cleanupRecording();
      options.onStatus(options.tr("status.aiVoiceStartFailed", { message: errorMessage(error) }), "error");
      render();
    }
  }

  function stopRecording(cancel: boolean) {
    if (starting && !recorder) {
      pendingStop = cancel;
      return;
    }
    if (!recorder || recorder.state === "inactive") return;
    stopAsCancel = cancel;
    try {
      recorder.stop();
    } catch (error) {
      cleanupRecording();
      options.onStatus(options.tr("status.aiVoiceFailed", { message: errorMessage(error) }), "error");
      render();
    }
  }

  async function finishRecording(cancel: boolean) {
    const mimeType = recorder?.mimeType || preferredMimeType() || "audio/webm";
    const pane = paneAtStart;
    const audioChunks = chunks;
    cleanupRecording();
    if (cancel || !pane || !audioChunks.length) {
      render();
      return;
    }
    const blob = new Blob(audioChunks, { type: mimeType });
    if (blob.size > MAX_VOICE_AUDIO_BYTES) {
      options.onStatus(options.tr("status.aiVoiceTooLarge"), "error");
      render();
      return;
    }
    uploading = true;
    render();
    try {
      const text = await transcribeBlob(blob, mimeType);
      if (text) {
        options.sendText(pane, text);
        options.focusTerminal();
        options.onStatus(options.tr("status.aiVoiceInserted"), "ok");
      } else {
        options.onStatus(options.tr("status.aiVoiceEmpty"), "neutral");
      }
    } catch (error) {
      options.onStatus(options.tr("status.aiVoiceFailed", { message: errorMessage(error) }), "error");
    } finally {
      uploading = false;
      render();
    }
  }

  function cleanupRecording() {
    recorder = undefined;
    paneAtStart = undefined;
    chunks = [];
    stopAsCancel = false;
    starting = false;
    pendingStop = undefined;
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }

  async function transcribeBlob(blob: Blob, mimeType: string): Promise<string> {
    const form = new FormData();
    form.append("mimeType", mimeType);
    form.append("audio", blob, `voice-input.${extensionForMime(mimeType)}`);
    const response = await fetch(new URL(VOICE_TRANSCRIPTION_ENDPOINT, window.location.href), {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || response.statusText);
    }
    const payload = await response.json() as { text?: string };
    return (payload.text ?? "").trim();
  }

  return { render };
}

function mediaRecorderAvailable(): boolean {
  return typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);
}

function mediaRecorderOptions(): MediaRecorderOptions {
  const mimeType = preferredMimeType();
  return mimeType ? { mimeType } : {};
}

function preferredMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/wav",
  ];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ?? "";
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/mp4") return "mp4";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  return "webm";
}
