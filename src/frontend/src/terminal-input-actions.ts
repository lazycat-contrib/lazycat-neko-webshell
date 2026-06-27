import type { MessageKey } from "./i18n";
import type { Settings, TerminalPane, Tone } from "./types";
import { aiVoiceProfileConfigured } from "./plugins/ai-chat/voice-profiles";
import { errorMessage, escapeAttr, escapeHtml } from "./utils";
import {
  createVoiceAudioRecorder,
  voiceRecordingAvailable,
  voiceRecordingFormatSupported,
  type VoiceAudioRecorder,
} from "./voice-recorder";

const MAX_VOICE_AUDIO_BYTES = 25 * 1024 * 1024;
const VOICE_TRANSCRIPTION_ENDPOINT = "./api/ai/voice/transcriptions";
const HOLD_TO_TALK_MS = 360;

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type TerminalInputActionController = {
  render: () => void;
};

export function createTerminalInputActionController(options: {
  root: HTMLDivElement;
  settings: () => Settings;
  activePane: () => TerminalPane | undefined;
  sendText: (pane: TerminalPane, text: string) => boolean | Promise<boolean>;
  uploadFilesToCurrentDirectory: (files: File[]) => void | Promise<void>;
  uploadFilesToTemporaryDirectory: (files: File[]) => string[] | Promise<string[]>;
  uploadImages: (files: File[]) => void | Promise<void>;
  currentDirectoryFileUploadAvailable: () => boolean;
  temporaryDirectoryFileUploadAvailable: () => boolean;
  imageUploadAvailable: () => boolean;
  focusTerminal: (pane: TerminalPane) => void;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  updateIcons: () => void;
}): TerminalInputActionController {
  let recorder: VoiceAudioRecorder | undefined;
  let paneAtStart: TerminalPane | undefined;
  let starting = false;
  let stopping = false;
  let pendingStop: boolean | undefined;
  let uploading = false;
  let runningUpload = false;
  let menuOpen = false;
  let menuMode: "main" | "file-target" = "main";
  let pendingFileTarget: "current" | "temporary" = "current";
  let suppressedByTyping = false;
  let holdTimer = 0;
  let holdStarted = false;
  let audioContext: AudioContext | undefined;
  let analyser: AnalyserNode | undefined;
  let rmsFrame = 0;
  let smoothedLevel = 0;
  let liveTranscript = "";

  document.addEventListener("keydown", (event) => {
    if (event.defaultPrevented || event.isComposing) return;
    if (event.key === "Escape" && menuOpen) {
      menuOpen = false;
      menuMode = "main";
      render();
      return;
    }
    if (event.target instanceof Element && event.target.closest(".terminal-input-actions-surface")) return;
    if (menuOpen) {
      menuOpen = false;
      menuMode = "main";
    }
    if (!recorder && !uploading && !runningUpload) {
      suppressedByTyping = true;
    }
    render();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element && options.root.contains(event.target))) {
      if (suppressedByTyping) {
        suppressedByTyping = false;
        render();
      }
    }
    if (!menuOpen) return;
    if (event.target instanceof Element && options.root.contains(event.target)) return;
    menuOpen = false;
    menuMode = "main";
    render();
  }, true);

  function render() {
    const shouldShow = Boolean(options.activePane() && (
      voiceMenuVisible()
      || options.currentDirectoryFileUploadAvailable()
      || options.temporaryDirectoryFileUploadAvailable()
      || options.imageUploadAvailable()
    ));
    if (!shouldShow) {
      if (recorder) {
        stopRecording(true);
      }
      menuOpen = false;
      menuMode = "main";
      suppressedByTyping = false;
      options.root.hidden = true;
      options.root.replaceChildren();
      return;
    }
    if (!options.root.firstElementChild) {
      options.root.innerHTML = `
        <div class="terminal-input-recording-pill" hidden aria-live="polite">
          <span class="terminal-input-waveform" aria-hidden="true">
            <i></i><i></i><i></i><i></i><i></i>
          </span>
          <span class="terminal-input-recording-label"></span>
        </div>
        <div class="terminal-input-action-menu" role="menu" hidden>
          <button class="terminal-input-menu-item" type="button" role="menuitem" data-terminal-input-action="voice">
            <i data-lucide="mic"></i>
            <span>${escapeHtml(options.tr("action.terminalInputVoice"))}</span>
          </button>
          <button class="terminal-input-menu-item" type="button" role="menuitem" data-terminal-input-action="image">
            <i data-lucide="image-up"></i>
            <span>${escapeHtml(options.tr("action.terminalInputUploadImage"))}</span>
          </button>
          <button class="terminal-input-menu-item" type="button" role="menuitem" data-terminal-input-action="file">
            <i data-lucide="file-up"></i>
            <span>${escapeHtml(options.tr("action.terminalInputUploadFile"))}</span>
          </button>
        </div>
        <div class="terminal-input-action-menu terminal-input-file-target-menu" role="menu" hidden>
          <button class="terminal-input-menu-item terminal-input-menu-back" type="button" role="menuitem" data-terminal-input-action="file-back">
            <i data-lucide="arrow-left"></i>
            <span>${escapeHtml(options.tr("action.back"))}</span>
          </button>
          <button class="terminal-input-menu-item" type="button" role="menuitem" data-terminal-input-action="file-current">
            <i data-lucide="folder-input"></i>
            <span>${escapeHtml(options.tr("action.terminalInputUploadFileCurrent"))}</span>
          </button>
          <button class="terminal-input-menu-item" type="button" role="menuitem" data-terminal-input-action="file-temporary">
            <i data-lucide="folder-clock"></i>
            <span>${escapeHtml(options.tr("action.terminalInputUploadFileTemporary"))}</span>
          </button>
        </div>
        <button class="terminal-input-action-button" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="${escapeAttr(options.tr("action.terminalInputActions"))}" title="${escapeAttr(options.tr("action.terminalInputActions"))}">
          <i data-lucide="plus"></i>
        </button>
        <input class="terminal-input-file-picker" data-terminal-input-file type="file" multiple aria-hidden="true" tabindex="-1" />
        <input class="terminal-input-file-picker" data-terminal-input-image type="file" accept="image/*" multiple aria-hidden="true" tabindex="-1" />
      `;
      bindSurfaceEvents();
    }
    options.root.hidden = false;
    syncSurfaceState();
    updateRecordingPill();
    options.updateIcons();
  }

  function bindSurfaceEvents() {
    const button = options.root.querySelector<HTMLButtonElement>(".terminal-input-action-button");
    const voiceButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"voice\"]");
    const imageButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"image\"]");
    const fileButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file\"]");
    const backButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file-back\"]");
    const currentFileButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file-current\"]");
    const temporaryFileButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file-temporary\"]");
    const imageInput = options.root.querySelector<HTMLInputElement>("[data-terminal-input-image]");
    const fileInput = options.root.querySelector<HTMLInputElement>("[data-terminal-input-file]");

    button?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (button.disabled) return;
      try {
        button.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort on older mobile browsers.
      }
      beginPrimaryHold();
    });
    button?.addEventListener("pointerup", (event) => {
      event.preventDefault();
      endPrimaryHold(false);
    });
    button?.addEventListener("pointercancel", (event) => {
      event.preventDefault();
      endPrimaryHold(true);
    });
    button?.addEventListener("lostpointercapture", () => {
      if (holdStarted) stopRecording(false);
      clearPrimaryHold();
    });
    button?.addEventListener("click", (event) => event.preventDefault());
    button?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      toggleMenu();
    });

    voiceButton?.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      if (voiceButton.disabled || uploading || runningUpload) return;
      try {
        voiceButton.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is best-effort on older mobile browsers.
      }
      menuOpen = false;
      render();
      void startRecording();
    });
    voiceButton?.addEventListener("pointerup", (event) => {
      event.preventDefault();
      stopRecording(false);
    });
    voiceButton?.addEventListener("pointercancel", (event) => {
      event.preventDefault();
      stopRecording(true);
    });
    voiceButton?.addEventListener("lostpointercapture", () => stopRecording(false));
    voiceButton?.addEventListener("click", (event) => event.preventDefault());
    voiceButton?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      if (event.repeat) return;
      if (voiceButton.disabled) return;
      menuOpen = false;
      render();
      void startRecording();
    });
    voiceButton?.addEventListener("keyup", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      stopRecording(false);
    });

    imageButton?.addEventListener("click", () => {
      if (imageButton.disabled) return;
      openFilePicker(imageInput);
      menuOpen = false;
      menuMode = "main";
      render();
    });
    fileButton?.addEventListener("click", () => {
      menuMode = "file-target";
      render();
    });
    backButton?.addEventListener("click", () => {
      menuMode = "main";
      render();
    });
    currentFileButton?.addEventListener("click", () => {
      if (currentFileButton.disabled) return;
      openFilePicker(fileInput);
      menuOpen = false;
      menuMode = "main";
      pendingFileTarget = "current";
      render();
    });
    temporaryFileButton?.addEventListener("click", () => {
      if (temporaryFileButton.disabled) return;
      openFilePicker(fileInput);
      menuOpen = false;
      menuMode = "main";
      pendingFileTarget = "temporary";
      render();
    });
    imageInput?.addEventListener("change", () => {
      const files = Array.from(imageInput.files ?? []);
      imageInput.value = "";
      if (files.length) void runSelectedUpload(files, "image");
    });
    fileInput?.addEventListener("change", () => {
      const files = Array.from(fileInput.files ?? []);
      const target = pendingFileTarget;
      pendingFileTarget = "current";
      fileInput.value = "";
      if (files.length) void runSelectedUpload(files, target);
    });
  }

  function syncSurfaceState() {
    const button = options.root.querySelector<HTMLButtonElement>(".terminal-input-action-button");
    const menu = options.root.querySelector<HTMLElement>(".terminal-input-action-menu");
    const voiceButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"voice\"]");
    const imageButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"image\"]");
    const fileButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file\"]");
    const mainMenu = options.root.querySelector<HTMLElement>(".terminal-input-action-menu:not(.terminal-input-file-target-menu)");
    const targetMenu = options.root.querySelector<HTMLElement>(".terminal-input-file-target-menu");
    const backButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file-back\"]");
    const currentFileButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file-current\"]");
    const temporaryFileButton = options.root.querySelector<HTMLButtonElement>("[data-terminal-input-action=\"file-temporary\"]");
    const voiceState = currentVoiceState();
    const busy = Boolean(recorder || uploading || runningUpload);

    options.root.dataset.state = recorder
      ? "recording"
      : uploading || runningUpload
        ? "uploading"
        : suppressedByTyping ? "suppressed-by-typing" : menuOpen ? "open" : "idle";

    if (button) {
      button.disabled = uploading || runningUpload || suppressedByTyping;
      button.dataset.state = options.root.dataset.state;
      button.setAttribute("aria-expanded", menuOpen ? "true" : "false");
      const title = voiceState.canStart
        ? options.tr("action.terminalInputActionsHold")
        : options.tr("action.terminalInputActions");
      button.setAttribute("aria-label", title);
      button.title = title;
    }
    if (menu) {
      const hasMenuAction = voiceState.visible
        || options.imageUploadAvailable()
        || options.currentDirectoryFileUploadAvailable()
        || options.temporaryDirectoryFileUploadAvailable();
      mainMenu && (mainMenu.hidden = !menuOpen || menuMode !== "main" || !hasMenuAction || busy || suppressedByTyping);
      targetMenu && (targetMenu.hidden = !menuOpen || menuMode !== "file-target" || busy || suppressedByTyping);
    }
    if (voiceButton) {
      voiceButton.hidden = !voiceState.visible;
      voiceButton.disabled = !voiceState.canStart || busy;
      voiceButton.title = voiceState.title;
      voiceButton.setAttribute("aria-label", voiceState.title);
    }
    if (imageButton) {
      const imageAvailable = options.imageUploadAvailable();
      imageButton.hidden = !imageAvailable;
      imageButton.disabled = !imageAvailable || busy;
      imageButton.title = options.tr("action.terminalInputUploadImage");
      imageButton.setAttribute("aria-label", imageButton.title);
    }
    if (fileButton) {
      const fileAvailable = options.currentDirectoryFileUploadAvailable() || options.temporaryDirectoryFileUploadAvailable();
      fileButton.hidden = !fileAvailable;
      fileButton.disabled = !fileAvailable || busy;
      fileButton.title = options.tr("action.terminalInputUploadFile");
      fileButton.setAttribute("aria-label", fileButton.title);
    }
    if (backButton) {
      backButton.disabled = busy;
      backButton.title = options.tr("action.back");
      backButton.setAttribute("aria-label", backButton.title);
    }
    if (currentFileButton) {
      const fileAvailable = options.currentDirectoryFileUploadAvailable();
      currentFileButton.hidden = !fileAvailable;
      currentFileButton.disabled = !fileAvailable || busy;
      currentFileButton.title = options.tr("action.terminalInputUploadFileCurrent");
      currentFileButton.setAttribute("aria-label", currentFileButton.title);
    }
    if (temporaryFileButton) {
      const fileAvailable = options.temporaryDirectoryFileUploadAvailable();
      temporaryFileButton.hidden = !fileAvailable;
      temporaryFileButton.disabled = !fileAvailable || busy;
      temporaryFileButton.title = options.tr("action.terminalInputUploadFileTemporary");
      temporaryFileButton.setAttribute("aria-label", temporaryFileButton.title);
    }
  }

  function toggleMenu() {
    if (uploading || runningUpload || recorder) return;
    menuOpen = !menuOpen;
    if (!menuOpen) menuMode = "main";
    render();
  }

  function openFilePicker(input: HTMLInputElement | null) {
    if (!input) return;
    input.value = "";
    input.click();
  }

  function beginPrimaryHold() {
    clearPrimaryHold();
    holdStarted = false;
    if (!currentVoiceState().canStart) return;
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      holdStarted = true;
      menuOpen = false;
      menuMode = "main";
      render();
      void startRecording();
    }, HOLD_TO_TALK_MS);
  }

  function endPrimaryHold(cancel: boolean) {
    const started = holdStarted;
    clearPrimaryHold();
    if (started || recorder || starting) {
      stopRecording(cancel);
      return;
    }
    if (!cancel) toggleMenu();
  }

  function clearPrimaryHold() {
    if (holdTimer) {
      window.clearTimeout(holdTimer);
      holdTimer = 0;
    }
    holdStarted = false;
  }

  async function runSelectedUpload(files: File[], type: "current" | "temporary" | "image") {
    if (runningUpload || uploading || !files.length) return;
    const available = type === "image"
      ? options.imageUploadAvailable()
      : type === "temporary" ? options.temporaryDirectoryFileUploadAvailable() : options.currentDirectoryFileUploadAvailable();
    if (!available) {
      options.onStatus(options.tr(type === "image" ? "status.terminalInputImageUploadUnavailable" : "status.terminalInputFileUploadUnavailable"), "error");
      return;
    }
    runningUpload = true;
    render();
    try {
      if (type === "image") {
        await options.uploadImages(files);
      } else if (type === "temporary") {
        const pane = options.activePane();
        const paths = await options.uploadFilesToTemporaryDirectory(files);
        if (pane && paths.length) {
          const sent = await options.sendText(pane, paths.map(shellQuotePath).join(" "));
          if (sent) {
            options.focusTerminal(pane);
            options.onStatus(options.tr("status.terminalInputTemporaryPathsInserted"), "ok");
          }
        }
      } else {
        await options.uploadFilesToCurrentDirectory(files);
      }
    } catch (error) {
      options.onStatus(errorMessage(error), "error");
    } finally {
      runningUpload = false;
      render();
    }
  }

  function voiceMenuVisible(): boolean {
    const settings = options.settings();
    return Boolean(settings.aiVoiceInputEnabled && voiceRecordingAvailable("auto"));
  }

  function currentVoiceState(): { visible: boolean; canStart: boolean; title: string } {
    const settings = options.settings();
    const activeProfile = settings.aiVoiceProviderProfiles.find((profile) => profile.id === settings.aiVoiceActiveProviderProfileId)
      ?? settings.aiVoiceProviderProfiles[0];
    const visible = voiceMenuVisible();
    if (!visible) {
      return { visible: false, canStart: false, title: options.tr("action.terminalInputVoice") };
    }
    const configured = aiVoiceProfileConfigured(activeProfile);
    const formatSupported = voiceRecordingFormatSupported(activeProfile?.format ?? "auto");
    const title = configured
      ? formatSupported ? options.tr("action.aiVoiceHold") : options.tr("ai.voiceFormatNotSupported")
      : options.tr("ai.voiceNotConfigured");
    return {
      visible: true,
      canStart: configured && formatSupported && !uploading && !runningUpload,
      title,
    };
  }

  async function startRecording() {
    if (starting || recorder || uploading || runningUpload || !currentVoiceState().canStart) return;
    const pane = options.activePane();
    if (!pane) return;
    paneAtStart = pane;
    starting = true;
    stopping = false;
    pendingStop = undefined;
    try {
      const settings = options.settings();
      const activeProfile = settings.aiVoiceProviderProfiles.find(
        (profile) => profile.id === settings.aiVoiceActiveProviderProfileId,
      ) ?? settings.aiVoiceProviderProfiles[0];
      const voiceRecorder = await createVoiceAudioRecorder(activeProfile?.format ?? "auto");
      recorder = voiceRecorder;
      startLevelMeter(voiceRecorder.stream);
      liveTranscript = options.tr("status.aiVoiceRecording");
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
    if (!recorder || stopping) return;
    stopping = true;
    void finishRecording(recorder, cancel);
  }

  async function finishRecording(activeRecorder: VoiceAudioRecorder, cancel: boolean) {
    const pane = paneAtStart;
    let blob: Blob | undefined;
    let mimeType = "audio/wav";
    let extension = "wav";
    try {
      if (cancel) {
        await activeRecorder.cancel();
      } else {
        const recording = await activeRecorder.stop();
        blob = recording.blob;
        mimeType = recording.mimeType;
        extension = recording.extension;
      }
    } catch (error) {
      options.onStatus(options.tr("status.aiVoiceFailed", { message: errorMessage(error) }), "error");
    }
    cleanupRecording();
    if (cancel || !pane || !blob) {
      render();
      return;
    }
    if (blob.size > MAX_VOICE_AUDIO_BYTES) {
      options.onStatus(options.tr("status.aiVoiceTooLarge"), "error");
      render();
      return;
    }
    uploading = true;
    liveTranscript = options.tr("status.aiVoiceTranscribing");
    render();
    try {
      const text = await transcribeBlob(blob, mimeType, extension);
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
    starting = false;
    stopping = false;
    pendingStop = undefined;
    stopLevelMeter();
  }

  async function transcribeBlob(blob: Blob, mimeType: string, extension: string): Promise<string> {
    const form = new FormData();
    form.append("mimeType", mimeType);
    form.append("audio", blob, `voice-input.${extension || extensionForMime(mimeType)}`);
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
    const pill = options.root.querySelector<HTMLElement>(".terminal-input-recording-pill");
    const label = options.root.querySelector<HTMLElement>(".terminal-input-recording-label");
    if (!pill || !label) return;
    const active = Boolean(recorder || uploading);
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
    const bars = Array.from(options.root.querySelectorAll<HTMLElement>(".terminal-input-waveform i"));
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
    const bars = Array.from(options.root.querySelectorAll<HTMLElement>(".terminal-input-waveform i"));
    bars.forEach((bar) => {
      bar.style.transform = "";
    });
  }
}

function extensionForMime(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase();
  if (normalized === "audio/mp4") return "mp4";
  if (normalized === "audio/wav" || normalized === "audio/wave" || normalized === "audio/x-wav") return "wav";
  if (normalized === "audio/mpeg" || normalized === "audio/mp3") return "mp3";
  return "webm";
}

function shellQuotePath(path: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(path)) return path;
  const escaped = path.replace(/'/g, "'\\''");
  return `'${escaped}'`;
}
