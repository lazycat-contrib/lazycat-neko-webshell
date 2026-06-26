import type { MessageKey } from "./i18n";
import type { Settings, TerminalPane, Tone } from "./types";
import { aiVoiceProfileConfigured } from "./plugins/ai-chat/voice-profiles";
import { errorMessage, escapeAttr } from "./utils";

const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
const VOICE_TRANSCRIPTION_ENDPOINT = "./api/ai/voice/transcriptions";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type VoiceInputController = {
  render: () => void;
};

export function createVoiceInputController(options: {
  root: HTMLDivElement;
  settings: () => Settings;
  activePane: () => TerminalPane | undefined;
  sendText: (pane: TerminalPane, text: string) => boolean | Promise<boolean>;
  focusTerminal: (pane: TerminalPane) => void;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  updateIcons: () => void;
}): VoiceInputController {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let chunks: Blob[] = [];
  let paneAtStart: TerminalPane | undefined;
  let stopAsCancel = false;
  let starting = false;
  let pendingStop: boolean | undefined;
  let uploading = false;
  let audioContext: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let rmsFrame = 0;
  let smoothedLevel = 0;
  let liveTranscript = "";
  let keyboardHideTimer = 0;

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.target instanceof Element && event.target.closest(".ai-voice-input-surface")) return;
    options.root.dataset.keyboardActive = "true";
    window.clearTimeout(keyboardHideTimer);
    keyboardHideTimer = window.setTimeout(() => {
      delete options.root.dataset.keyboardActive;
    }, 1400);
  }, true);

  function render() {
    const settings = options.settings();
    const activeProfile = settings.aiVoiceProviderProfiles.find((profile) => profile.id === settings.aiVoiceActiveProviderProfileId)
      ?? settings.aiVoiceProviderProfiles[0];
    const shouldShow = Boolean(
      settings.aiVoiceInputEnabled
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
        <div class="ai-voice-recording-pill" hidden aria-live="polite">
          <span class="ai-voice-waveform" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i>
          </span>
          <span class="ai-voice-recording-label"></span>
        </div>
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
    updateRecordingPill();
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
      startLevelMeter(mediaStream);
      chunks = [];
      stopAsCancel = false;
      liveTranscript = options.tr("status.aiVoiceRecording");
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
    liveTranscript = options.tr("status.aiVoiceTranscribing");
    render();
    try {
      const text = await transcribeBlob(blob, mimeType);
      if (text) {
        liveTranscript = text;
        render();
        const sent = await options.sendText(pane, text);
        if (sent) {
          options.focusTerminal(pane);
          options.onStatus(options.tr("status.aiVoiceInserted"), "ok");
        } else {
          options.onStatus(options.tr("status.aiNoTerminalTarget"), "error");
        }
      } else {
        liveTranscript = options.tr("status.aiVoiceEmpty");
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
    stopLevelMeter();
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

  function updateRecordingPill() {
    const pill = options.root.querySelector<HTMLElement>(".ai-voice-recording-pill");
    const label = options.root.querySelector<HTMLElement>(".ai-voice-recording-label");
    if (!pill || !label) return;
    const active = Boolean((recorder && recorder.state !== "inactive") || uploading);
    pill.hidden = !active;
    label.textContent = liveTranscript || options.tr(uploading ? "status.aiVoiceTranscribing" : "status.aiVoiceRecording");
  }

  function startLevelMeter(mediaStream: MediaStream) {
    stopLevelMeter();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    try {
      audioContext = new AudioContextClass();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      const source = audioContext.createMediaStreamSource(mediaStream);
      source.connect(analyser);
      tickLevelMeter();
    } catch {
      stopLevelMeter();
    }
  }

  function tickLevelMeter() {
    if (!analyser) return;
    const samples = new Uint8Array(analyser.fftSize);
    const weights = [0.5, 0.8, 1, 0.75, 0.55];
    const bars = Array.from(options.root.querySelectorAll<HTMLElement>(".ai-voice-waveform i"));
    const frame = () => {
      if (!analyser) return;
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const value of samples) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.min(1, Math.sqrt(sum / samples.length) * 5);
      const coefficient = rms > smoothedLevel ? 0.4 : 0.15;
      smoothedLevel += (rms - smoothedLevel) * coefficient;
      bars.forEach((bar, index) => {
        const jitter = 0.96 + Math.random() * 0.08;
        const scale = 0.22 + smoothedLevel * weights[index] * jitter;
        bar.style.transform = `scaleY(${Math.min(1, scale).toFixed(3)})`;
      });
      rmsFrame = window.requestAnimationFrame(frame);
    };
    rmsFrame = window.requestAnimationFrame(frame);
  }

  function stopLevelMeter() {
    if (rmsFrame) {
      window.cancelAnimationFrame(rmsFrame);
      rmsFrame = 0;
    }
    analyser = undefined;
    if (audioContext) {
      void audioContext.close().catch(() => {});
      audioContext = undefined;
    }
    smoothedLevel = 0;
    const bars = Array.from(options.root.querySelectorAll<HTMLElement>(".ai-voice-waveform i"));
    bars.forEach((bar) => {
      bar.style.transform = "";
    });
  }
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
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
