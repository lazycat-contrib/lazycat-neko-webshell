import type { AiVoiceInputFormat } from "./types";

export type VoiceAudioRecorder = {
  readonly stream: MediaStream;
  readonly mimeType: string;
  readonly extension: string;
  stop: () => Promise<VoiceAudioRecording>;
  cancel: () => Promise<void>;
};

export type VoiceAudioRecording = {
  blob: Blob;
  mimeType: string;
  extension: string;
};

const WAV_MIME_TYPE = "audio/wav";
const WEBM_OPUS_MIME_TYPE = "audio/webm;codecs=opus";

export function voiceRecordingAvailable(format: AiVoiceInputFormat = "auto"): boolean {
  return Boolean(resolveVoiceRecorderFormat(format));
}

export function voiceRecordingFormatSupported(format: AiVoiceInputFormat): boolean {
  return Boolean(resolveVoiceRecorderFormat(format));
}

export async function createVoiceAudioRecorder(format: AiVoiceInputFormat = "auto"): Promise<VoiceAudioRecorder> {
  const resolved = resolveVoiceRecorderFormat(format);
  if (!resolved) {
    throw new Error(`voice recording format is not supported: ${format}`);
  }
  return resolved.kind === "wav"
    ? createWavVoiceAudioRecorder()
    : createMediaVoiceAudioRecorder(resolved.mimeType, resolved.extension);
}

type ResolvedVoiceRecorderFormat =
  | { kind: "wav"; mimeType: typeof WAV_MIME_TYPE; extension: "wav" }
  | { kind: "media"; mimeType: string; extension: string };

function resolveVoiceRecorderFormat(format: AiVoiceInputFormat): ResolvedVoiceRecorderFormat | undefined {
  if (format === "wav") {
    return webAudioAvailable()
      ? { kind: "wav", mimeType: WAV_MIME_TYPE, extension: "wav" }
      : undefined;
  }
  if (format === "auto") {
    const media = firstSupportedMediaFormat([
      { mimeType: WEBM_OPUS_MIME_TYPE, extension: "webm" },
      { mimeType: "audio/webm", extension: "webm" },
      { mimeType: "audio/mp4", extension: "mp4" },
    ]);
    if (media) return media;
    return webAudioAvailable()
      ? { kind: "wav", mimeType: WAV_MIME_TYPE, extension: "wav" }
      : undefined;
  }
  return mediaRecorderFormat(format);
}

function mediaRecorderFormat(format: AiVoiceInputFormat): ResolvedVoiceRecorderFormat | undefined {
  if (format === "webm-opus") {
    return mediaRecorderSupports(WEBM_OPUS_MIME_TYPE)
      ? { kind: "media", mimeType: WEBM_OPUS_MIME_TYPE, extension: "webm" }
      : undefined;
  }
  if (format === "webm") {
    return mediaRecorderSupports("audio/webm")
      ? { kind: "media", mimeType: "audio/webm", extension: "webm" }
      : undefined;
  }
  if (format === "mp4") {
    return mediaRecorderSupports("audio/mp4")
      ? { kind: "media", mimeType: "audio/mp4", extension: "mp4" }
      : undefined;
  }
  if (format === "m4a") {
    return mediaRecorderSupports("audio/mp4")
      ? { kind: "media", mimeType: "audio/mp4", extension: "m4a" }
      : undefined;
  }
  if (format === "mp3" || format === "mpeg") {
    return mediaRecorderSupports("audio/mpeg")
      ? { kind: "media", mimeType: "audio/mpeg", extension: format === "mp3" ? "mp3" : "mpeg" }
      : undefined;
  }
  if (format === "mpga") {
    return mediaRecorderSupports("audio/mpga")
      ? { kind: "media", mimeType: "audio/mpga", extension: "mpga" }
      : undefined;
  }
  return undefined;
}

function firstSupportedMediaFormat(formats: Array<{ mimeType: string; extension: string }>): ResolvedVoiceRecorderFormat | undefined {
  const supported = formats.find((format) => mediaRecorderSupports(format.mimeType));
  return supported ? { kind: "media", ...supported } : undefined;
}

function webAudioAvailable(): boolean {
  const AudioContextClass = audioContextConstructor();
  return typeof navigator.mediaDevices?.getUserMedia === "function" && Boolean(AudioContextClass);
}

function mediaRecorderSupports(mimeType: string): boolean {
  return typeof MediaRecorder !== "undefined"
    && typeof navigator.mediaDevices?.getUserMedia === "function"
    && MediaRecorder.isTypeSupported(mimeType);
}

async function createWavVoiceAudioRecorder(): Promise<VoiceAudioRecorder> {
  const AudioContextClass = audioContextConstructor();
  if (!AudioContextClass) {
    throw new Error("Web Audio is not available");
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const audioContext = new AudioContextClass();
  await audioContext.resume().catch(() => {});

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(4096, 1, 1);
  const silence = audioContext.createGain();
  silence.gain.value = 0;

  const chunks: Float32Array[] = [];
  let sampleCount = 0;
  let closed = false;

  processor.onaudioprocess = (event) => {
    if (closed) return;
    const input = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(input));
    sampleCount += input.length;
  };

  source.connect(processor);
  processor.connect(silence);
  silence.connect(audioContext.destination);

  async function cleanup() {
    if (closed) return;
    closed = true;
    processor.onaudioprocess = null;
    safeDisconnect(source);
    safeDisconnect(processor);
    safeDisconnect(silence);
    stream.getTracks().forEach((track) => track.stop());
    await audioContext.close().catch(() => {});
  }

  return {
    stream,
    mimeType: WAV_MIME_TYPE,
    extension: "wav",
    async stop() {
      await cleanup();
      return {
        blob: new Blob([encodePcm16Wav(chunks, sampleCount, audioContext.sampleRate)], { type: WAV_MIME_TYPE }),
        mimeType: WAV_MIME_TYPE,
        extension: "wav",
      };
    },
    async cancel() {
      await cleanup();
    },
  };
}

async function createMediaVoiceAudioRecorder(mimeType: string, extension: string): Promise<VoiceAudioRecorder> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream, { mimeType });
  let stopped: Promise<void> | undefined;
  let closed = false;

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  });
  recorder.start();

  function stopRecorder(): Promise<void> {
    if (stopped) return stopped;
    stopped = new Promise((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(), { once: true });
      recorder.addEventListener("error", () => reject(new Error("voice recording failed")), { once: true });
      if (recorder.state === "inactive") {
        resolve();
        return;
      }
      recorder.stop();
    });
    return stopped;
  }

  function cleanupTracks() {
    if (closed) return;
    closed = true;
    stream.getTracks().forEach((track) => track.stop());
  }

  return {
    stream,
    mimeType,
    extension,
    async stop() {
      await stopRecorder();
      cleanupTracks();
      return {
        blob: new Blob(chunks, { type: mimeType }),
        mimeType,
        extension,
      };
    },
    async cancel() {
      try {
        await stopRecorder();
      } finally {
        cleanupTracks();
      }
    },
  };
}

function audioContextConstructor(): typeof AudioContext | undefined {
  return typeof window.AudioContext === "undefined" ? window.webkitAudioContext : window.AudioContext;
}

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

function safeDisconnect(node: AudioNode) {
  try {
    node.disconnect();
  } catch {
    // Already disconnected.
  }
}

function encodePcm16Wav(chunks: Float32Array[], sampleCount: number, sampleRate: number): ArrayBuffer {
  const bytesPerSample = 2;
  const channelCount = 1;
  const dataSize = sampleCount * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * bytesPerSample, true);
  view.setUint16(32, channelCount * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (const sample of chunk) {
      const clamped = Math.max(-1, Math.min(1, sample));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += bytesPerSample;
    }
  }

  return buffer;
}

function writeAscii(view: DataView, offset: number, value: string) {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}
