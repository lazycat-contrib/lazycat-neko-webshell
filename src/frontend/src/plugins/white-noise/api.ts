export type SoundFile = {
  id: string;
  name: string;
  category: string;
  path: string;
  url: string;
  extension: string;
  sizeBytes: number;
};

export type SoundCatalog = {
  rootPath: string;
  exists: boolean;
  files: SoundFile[];
};

export type SoundPackageInstallResult = {
  downloadedBytes: number;
  extractedBytes: number;
  extractedFiles: number;
  skippedFiles: number;
  catalog: SoundCatalog;
};

export type SoundPackageInstallProgress = {
  phase: "download" | "extract" | "complete";
  downloadedBytes: number;
  totalBytes: number;
  extractedBytes: number;
  extractedFiles: number;
  totalFiles: number;
  skippedFiles: number;
};

export const SUPPORTED_SOUND_FORMATS = [".mp3", ".wav", ".ogg", ".flac", ".m4a", ".webm"] as const;
export const DEFAULT_SOUND_PACKAGE_URL = "https://share.pushcat.eu.org/sounds.zip";

export async function fetchSoundCatalog(): Promise<SoundCatalog> {
  const response = await fetch("/api/sounds", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return normalizeSoundCatalog(await response.json());
}

export async function installSoundPackage(
  url: string,
  onProgress?: (progress: SoundPackageInstallProgress) => void,
): Promise<SoundPackageInstallResult> {
  const response = await fetch("/api/sounds/package", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ url }),
  });
  if (!response.ok) {
    const message = (await response.text()).trim();
    throw new Error(message || `HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("sound package progress stream is unavailable");
  }
  return readSoundPackageInstallStream(response.body, onProgress);
}

function normalizeSoundCatalog(value: unknown): SoundCatalog {
  const raw = isRecord(value) ? value : {};
  const files = Array.isArray(raw.files)
    ? raw.files.map(normalizeSoundFile).filter((file): file is SoundFile => Boolean(file))
    : [];
  return {
    rootPath: stringField(raw.rootPath) || "/lzcapp/var/sounds",
    exists: Boolean(raw.exists),
    files,
  };
}

function normalizeSoundPackageInstallResult(value: unknown): SoundPackageInstallResult {
  const raw = isRecord(value) ? value : {};
  return {
    downloadedBytes: numberField(raw.downloadedBytes),
    extractedBytes: numberField(raw.extractedBytes),
    extractedFiles: numberField(raw.extractedFiles),
    skippedFiles: numberField(raw.skippedFiles),
    catalog: normalizeSoundCatalog(raw.catalog),
  };
}

async function readSoundPackageInstallStream(
  body: ReadableStream<Uint8Array>,
  onProgress?: (progress: SoundPackageInstallProgress) => void,
): Promise<SoundPackageInstallResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let result: SoundPackageInstallResult | undefined;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
      const lines = buffer.split("\n");
      buffer = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = parseInstallEvent(line);
        if (event.status === "error") {
          throw new Error(stringField(event.message) || "sound package install failed");
        }
        const progress = normalizeSoundPackageInstallProgress(event);
        if (event.status === "done") {
          result = normalizeSoundPackageInstallResult(event);
        } else {
          onProgress?.(progress);
        }
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  if (!result) {
    throw new Error("sound package install did not complete");
  }
  return result;
}

function parseInstallEvent(line: string): Record<string, unknown> {
  try {
    const value = JSON.parse(line);
    return isRecord(value) ? value : {};
  } catch {
    return {
      status: "error",
      message: "invalid sound package progress event",
    };
  }
}

function normalizeSoundPackageInstallProgress(value: unknown): SoundPackageInstallProgress {
  const raw = isRecord(value) ? value : {};
  const phase = stringField(raw.phase);
  return {
    phase: phase === "extract" || phase === "complete" ? phase : "download",
    downloadedBytes: numberField(raw.downloadedBytes),
    totalBytes: numberField(raw.totalBytes),
    extractedBytes: numberField(raw.extractedBytes),
    extractedFiles: numberField(raw.extractedFiles),
    totalFiles: numberField(raw.totalFiles),
    skippedFiles: numberField(raw.skippedFiles),
  };
}

function normalizeSoundFile(value: unknown): SoundFile | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringField(value.id) || stringField(value.path);
  const url = stringField(value.url);
  if (!id || !url) return undefined;
  return {
    id,
    name: stringField(value.name) || id.split("/").pop() || id,
    category: stringField(value.category) || "Root",
    path: stringField(value.path) || id,
    url,
    extension: stringField(value.extension),
    sizeBytes: numberField(value.sizeBytes),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
