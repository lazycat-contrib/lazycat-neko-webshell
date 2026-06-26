const VOICE_SPEECH_ENDPOINT = "./api/ai/voice/speech";
const AUDIO_READY_TIMEOUT_MS = 5000;

export type VoiceSpeechAudioBlob = {
  blob: Blob;
  contentType: string;
  sizeBytes: number;
};

export type VoiceSpeechAudioSource = VoiceSpeechAudioBlob & {
  audio: HTMLAudioElement;
  objectUrl: string;
  durationSeconds?: number;
};

export async function fetchVoiceSpeechAudio(
  text: string,
  options: { test?: boolean } = {},
): Promise<VoiceSpeechAudioBlob> {
  const response = await fetch(new URL(VOICE_SPEECH_ENDPOINT, window.location.href), {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: text.trim(), test: Boolean(options.test) }),
  });
  if (!response.ok) {
    throw new Error(await response.text() || `HTTP ${response.status}`);
  }
  const blob = await response.blob();
  const contentType = normalizeContentType(response.headers.get("content-type") || blob.type);
  if (!blob.size) {
    throw new Error("speech endpoint returned an empty audio file");
  }
  if (!contentType.startsWith("audio/")) {
    throw new Error(`speech endpoint returned ${contentType || "unknown content"} (${blob.size} bytes), not audio`);
  }
  return {
    blob,
    contentType,
    sizeBytes: blob.size,
  };
}

export async function createVoiceSpeechAudioSource(source: VoiceSpeechAudioBlob): Promise<VoiceSpeechAudioSource> {
  const objectUrl = URL.createObjectURL(source.blob);
  const audio = new Audio(objectUrl);
  audio.preload = "metadata";
  try {
    await waitForPlayableAudio(audio);
  } catch (error) {
    releaseAudioElement(audio);
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
  return {
    ...source,
    audio,
    objectUrl,
    durationSeconds: finiteDuration(audio.duration),
  };
}

export function releaseAudioElement(audio: HTMLAudioElement) {
  audio.pause();
  audio.src = "";
  audio.load();
}

export function finiteDuration(value: number): number | undefined {
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeContentType(value: string | null): string {
  return (value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

function waitForPlayableAudio(audio: HTMLAudioElement): Promise<void> {
  if (finiteDuration(audio.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = window.setTimeout(() => {
      finish(audio.error ? audioErrorMessage(audio.error) : "audio could not be prepared for playback", true);
    }, AUDIO_READY_TIMEOUT_MS);

    function finish(message: string | undefined, failed: boolean) {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      audio.removeEventListener("loadedmetadata", ready);
      audio.removeEventListener("canplay", ready);
      audio.removeEventListener("durationchange", ready);
      audio.removeEventListener("error", failedReady);
      if (failed) {
        reject(new Error(message || "audio playback failed"));
      } else {
        resolve();
      }
    }

    function ready() {
      finish(undefined, false);
    }

    function failedReady() {
      finish(audioErrorMessage(audio.error), true);
    }

    audio.addEventListener("loadedmetadata", ready, { once: true });
    audio.addEventListener("canplay", ready, { once: true });
    audio.addEventListener("durationchange", ready, { once: true });
    audio.addEventListener("error", failedReady, { once: true });
    audio.load();
  });
}

function audioErrorMessage(error: MediaError | null): string {
  if (!error) return "audio playback failed";
  if (error.code === 1) return "audio loading was aborted";
  if (error.code === 2) return "audio loading failed";
  if (error.code === 3) return "audio could not be decoded";
  if (error.code === 4) return "audio source is not supported by this browser";
  return error.message || "audio playback failed";
}
