import type { MessageKey } from "../../i18n";
import type { AIChatMessage, AIChatSession, Settings, Tone } from "../../types";
import { errorMessage } from "../../utils";
import { createVoiceSpeechAudioSource, fetchVoiceSpeechAudio, finiteDuration, releaseAudioElement } from "./voice-audio";
import { aiVoiceSpeechProfileConfigured } from "./voice-speech-profiles";

const MAX_AUDIO_CACHE_ENTRIES = 8;

export type AiVoiceReplyPlaybackStatus = "idle" | "loading" | "ready" | "playing" | "error";

export type AiVoiceReplyPlaybackState = {
  status: AiVoiceReplyPlaybackStatus;
  currentSeconds?: number;
  durationSeconds?: number;
  error?: string;
  textExpanded: boolean;
};

type AiVoiceReplyPlaybackStateUpdate =
  Omit<AiVoiceReplyPlaybackState, "textExpanded">
  & Partial<Pick<AiVoiceReplyPlaybackState, "textExpanded">>;

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
  const expandedTextKeys = new Set<string>();
  let activeKey = "";

  function stateFor(sessionId: string, messageIndex: number, content: string): AiVoiceReplyPlaybackState {
    const key = messageKey(sessionId, messageIndex, content);
    return {
      ...(entries.get(key)?.state ?? { status: "idle" }),
      textExpanded: expandedTextKeys.has(key),
    };
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

  function toggleText(session: AIChatSession | undefined, messageIndex: number) {
    const message = Number.isInteger(messageIndex) ? session?.messages[messageIndex] : undefined;
    if (!session || !voiceReplyShouldRender(options.settings(), message)) return;
    const key = messageKey(session.id, messageIndex, message.content);
    if (expandedTextKeys.has(key)) {
      expandedTextKeys.delete(key);
    } else {
      expandedTextKeys.add(key);
    }
    options.onRender();
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
      const source = await createVoiceSpeechAudioSource(await fetchVoiceSpeechAudio(content.trim()));
      releaseEntryAudio(entry);
      entry.audio = source.audio;
      entry.objectUrl = source.objectUrl;
      bindAudioEvents(key, entry);
      setEntryState(key, {
        status: flags.autoplay ? "playing" : "ready",
        currentSeconds: 0,
        durationSeconds: source.durationSeconds,
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
      state: { status: "idle", textExpanded: expandedTextKeys.has(key) },
      lastUsedAt: Date.now(),
    };
    entries.set(key, entry);
    return entry;
  }

  function setEntryState(key: string, state: AiVoiceReplyPlaybackStateUpdate) {
    const entry = ensureEntry(key);
    entry.state = {
      ...state,
      textExpanded: expandedTextKeys.has(key),
    };
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
    toggleText,
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

function releaseEntryAudio(entry: VoiceReplyEntry) {
  if (entry.audio) {
    releaseAudioElement(entry.audio);
    entry.audio = undefined;
  }
  if (entry.objectUrl) {
    URL.revokeObjectURL(entry.objectUrl);
    entry.objectUrl = undefined;
  }
}
