import type { MessageKey } from "../../i18n";
import type { AIChatMessage, AIChatSession, Settings, Tone } from "../../types";
import { errorMessage } from "../../utils";
import { aiVoiceSpeechProfileConfigured } from "./voice-speech-profiles";

const VOICE_SPEECH_ENDPOINT = "./api/ai/voice/speech";
const MAX_AUDIO_CACHE_ENTRIES = 8;

export type AiVoiceReplyPlaybackStatus = "idle" | "loading" | "ready" | "playing" | "error";

export type AiVoiceReplyPlaybackState = {
  status: AiVoiceReplyPlaybackStatus;
  currentSeconds?: number;
  durationSeconds?: number;
  error?: string;
};

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type VoiceReplyEntry = {
  state: AiVoiceReplyPlaybackState;
  audio?: HTMLAudioElement;
  objectUrl?: string;
  lastUsedAt: number;
};

export function createAiVoiceReplyController(options: {
  settings: () => Settings;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
}) {
  const entries = new Map<string, VoiceReplyEntry>();
  let activeKey = "";

  function stateFor(sessionId: string, messageIndex: number, content: string): AiVoiceReplyPlaybackState {
    return entries.get(messageKey(sessionId, messageIndex, content))?.state ?? { status: "idle" };
  }

  function prepareAssistantMessage(session: AIChatSession, messageIndex: number, message: AIChatMessage) {
    if (!voiceReplyShouldRender(options.settings(), message)) return;
    void prepare(session.id, messageIndex, message.content, { silent: true, autoplay: false });
  }

  async function toggle(session: AIChatSession | undefined, messageIndex: number) {
    const message = Number.isInteger(messageIndex) ? session?.messages[messageIndex] : undefined;
    if (!session || !voiceReplyShouldRender(options.settings(), message)) return;
    const key = messageKey(session.id, messageIndex, message.content);
    const entry = entries.get(key);
    if (entry?.audio && activeKey === key && !entry.audio.paused) {
      entry.audio.pause();
      setEntryState(key, { ...entry.state, status: "ready" });
      activeKey = "";
      options.onRender();
      return;
    }
    const prepared = entry?.audio
      ? entry
      : await prepare(session.id, messageIndex, message.content, { silent: false, autoplay: false });
    if (!prepared?.audio) return;
    pauseActive(key);
    activeKey = key;
    prepared.lastUsedAt = Date.now();
    setEntryState(key, {
      ...prepared.state,
      status: "playing",
      currentSeconds: prepared.audio.currentTime,
      durationSeconds: finiteDuration(prepared.audio.duration) ?? prepared.state.durationSeconds,
    });
    options.onRender();
    try {
      await prepared.audio.play();
    } catch (error) {
      setEntryState(key, {
        ...prepared.state,
        status: "error",
        error: errorMessage(error),
      });
      activeKey = "";
      options.onStatus(options.tr("status.aiVoiceReplyFailed", { message: errorMessage(error) }), "error");
      options.onRender();
    }
  }

  async function prepare(
    sessionId: string,
    messageIndex: number,
    content: string,
    flags: { silent: boolean; autoplay: boolean },
  ): Promise<VoiceReplyEntry | undefined> {
    const settings = options.settings();
    const profile = settings.aiVoiceReplyProviderProfiles.find(
      (item) => item.id === settings.aiVoiceReplyActiveProviderProfileId,
    ) ?? settings.aiVoiceReplyProviderProfiles[0];
    if (!settings.aiVoiceReplyEnabled || !content.trim()) return undefined;
    if (!aiVoiceSpeechProfileConfigured(profile)) {
      if (!flags.silent) {
        options.onStatus(options.tr("ai.voiceReplyNotConfigured"), "error");
      }
      return undefined;
    }
    const key = messageKey(sessionId, messageIndex, content);
    const existing = entries.get(key);
    if (existing?.state.status === "loading" || existing?.audio) return existing;
    const entry = ensureEntry(key);
    setEntryState(key, { status: "loading" });
    options.onRender();
    try {
      const response = await fetch(new URL(VOICE_SPEECH_ENDPOINT, window.location.href), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: content.trim() }),
      });
      if (!response.ok) {
        throw new Error(await response.text() || `HTTP ${response.status}`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      releaseEntryAudio(entry);
      const audio = new Audio(objectUrl);
      entry.audio = audio;
      entry.objectUrl = objectUrl;
      bindAudioEvents(key, entry);
      await waitForMetadata(audio);
      setEntryState(key, {
        status: flags.autoplay ? "playing" : "ready",
        currentSeconds: 0,
        durationSeconds: finiteDuration(audio.duration),
      });
      pruneAudioCache();
      options.onRender();
      return entry;
    } catch (error) {
      releaseEntryAudio(entry);
      setEntryState(key, {
        status: "error",
        error: errorMessage(error),
      });
      if (!flags.silent) {
        options.onStatus(options.tr("status.aiVoiceReplyFailed", { message: errorMessage(error) }), "error");
      }
      options.onRender();
      return entry;
    }
  }

  function bindAudioEvents(key: string, entry: VoiceReplyEntry) {
    const audio = entry.audio;
    if (!audio) return;
    audio.addEventListener("ended", () => {
      if (activeKey === key) activeKey = "";
      setEntryState(key, {
        ...entry.state,
        status: "ready",
        currentSeconds: 0,
        durationSeconds: finiteDuration(audio.duration) ?? entry.state.durationSeconds,
      });
      audio.currentTime = 0;
      options.onRender();
    });
    audio.addEventListener("pause", () => {
      if (audio.ended || activeKey !== key) return;
      setEntryState(key, {
        ...entry.state,
        status: "ready",
        currentSeconds: audio.currentTime,
        durationSeconds: finiteDuration(audio.duration) ?? entry.state.durationSeconds,
      });
      activeKey = "";
      options.onRender();
    });
    audio.addEventListener("timeupdate", () => {
      if (activeKey !== key) return;
      const currentSecond = Math.floor(audio.currentTime);
      if (Math.floor(entry.state.currentSeconds ?? -1) === currentSecond) return;
      setEntryState(key, {
        ...entry.state,
        status: "playing",
        currentSeconds: audio.currentTime,
        durationSeconds: finiteDuration(audio.duration) ?? entry.state.durationSeconds,
      });
      options.onRender();
    });
  }

  function pauseActive(nextKey: string) {
    if (!activeKey || activeKey === nextKey) return;
    const entry = entries.get(activeKey);
    if (entry?.audio && !entry.audio.paused) {
      entry.audio.pause();
    }
    activeKey = "";
  }

  function ensureEntry(key: string): VoiceReplyEntry {
    const existing = entries.get(key);
    if (existing) {
      existing.lastUsedAt = Date.now();
      return existing;
    }
    const entry: VoiceReplyEntry = {
      state: { status: "idle" },
      lastUsedAt: Date.now(),
    };
    entries.set(key, entry);
    return entry;
  }

  function setEntryState(key: string, state: AiVoiceReplyPlaybackState) {
    const entry = ensureEntry(key);
    entry.state = state;
    entry.lastUsedAt = Date.now();
  }

  function pruneAudioCache() {
    if (entries.size <= MAX_AUDIO_CACHE_ENTRIES) return;
    const stale = Array.from(entries.entries())
      .filter(([key]) => key !== activeKey)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    for (const [key, entry] of stale.slice(0, entries.size - MAX_AUDIO_CACHE_ENTRIES)) {
      releaseEntryAudio(entry);
      entries.delete(key);
    }
  }

  return {
    stateFor,
    prepareAssistantMessage,
    toggle,
  };
}

function voiceReplyShouldRender(settings: Settings, message: AIChatMessage | undefined): message is AIChatMessage {
  return Boolean(
    settings.aiVoiceReplyEnabled
      && message?.role === "assistant"
      && message.tone !== "error"
      && message.content.trim(),
  );
}

function messageKey(sessionId: string, messageIndex: number, content: string): string {
  return `${sessionId}:${messageIndex}:${hashString(content)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function waitForMetadata(audio: HTMLAudioElement): Promise<void> {
  if (Number.isFinite(audio.duration) && audio.duration > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = window.setTimeout(done, 2000);
    function done() {
      window.clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", done);
      audio.removeEventListener("durationchange", done);
      resolve();
    }
    audio.addEventListener("loadedmetadata", done, { once: true });
    audio.addEventListener("durationchange", done, { once: true });
    audio.load();
  });
}

function finiteDuration(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function releaseEntryAudio(entry: VoiceReplyEntry) {
  if (entry.audio) {
    entry.audio.pause();
    entry.audio.src = "";
    entry.audio.load();
    entry.audio = undefined;
  }
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = undefined;
  }
}
