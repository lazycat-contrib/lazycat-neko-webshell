import { DEFAULT_SETTINGS } from "./config";
import { migrateSettings } from "./migrate";
import type { Settings } from "./types";

const SETTINGS_KEY = "lazycat-neko-webshell.settings";
const SETTINGS_ENDPOINT = "./api/settings";

export function loadLocalSettings(): Settings {
  const raw = readLocalSettings();
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return migrateSettings(JSON.parse(raw) as Partial<Settings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function loadSettings(): Promise<Settings> {
  const localSettings = loadLocalSettings();
  try {
    const response = await fetch(new URL(SETTINGS_ENDPOINT, window.location.href), {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) return localSettings;
    const value = await response.json() as Partial<Settings>;
    const settings = migrateSettings({ ...localSettings, ...value });
    saveLocalSettings(settings);
    return settings;
  } catch {
    return localSettings;
  }
}

export function saveSettings(settings: Settings): Promise<void> {
  saveLocalSettings(settings);
  return saveRemoteSettings(settings);
}

function readLocalSettings(): string | null {
  try {
    return localStorage.getItem(SETTINGS_KEY);
  } catch {
    return null;
  }
}

function saveLocalSettings(settings: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Server-side settings remain the source of truth when browser storage is unavailable.
  }
}

async function saveRemoteSettings(settings: Settings) {
  try {
    const body = JSON.stringify(settings);
    await fetch(new URL(SETTINGS_ENDPOINT, window.location.href), {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body,
      keepalive: body.length < 64 * 1024,
    });
  } catch {
    // Local storage fallback keeps the UI usable if the backend is temporarily unavailable.
  }
}
