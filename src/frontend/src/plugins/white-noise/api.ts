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
