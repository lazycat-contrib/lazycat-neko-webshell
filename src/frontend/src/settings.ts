import { DEFAULT_SETTINGS, INTERFACE_STYLE_IDS, MAX_CUSTOM_THEME_SOURCE_BYTES, MAX_OUTPUT_BUFFER_LIMIT, MIN_OUTPUT_BUFFER_LIMIT } from "./config";
import type { CustomTerminalTheme, InterfaceStyleId, Settings } from "./types";
import { clampNumber } from "./utils";

const SETTINGS_KEY = "lazycat-neko-webshell.settings";
const SETTINGS_ENDPOINT = "./api/settings";

export function loadLocalSettings(): Settings {
  const raw = readLocalSettings();
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(JSON.parse(raw) as Partial<Settings>);
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
    const settings = normalizeSettings({ ...localSettings, ...value });
    saveLocalSettings(settings);
    return settings;
  } catch {
    return localSettings;
  }
}

export function normalizeSettings(value: Partial<Settings>): Settings {
  const terminalBackgroundUrl = normalizeTerminalBackgroundUrl(value.terminalBackgroundUrl);
  return {
    locale: value.locale === "en" || value.locale === "zh-CN" ? value.locale : DEFAULT_SETTINGS.locale,
    themeId: typeof value.themeId === "string" ? value.themeId : DEFAULT_SETTINGS.themeId,
    interfaceStyleId: normalizeInterfaceStyleId(value.interfaceStyleId),
    customThemes: normalizeCustomThemes(value.customThemes),
    fontFamilyId: typeof value.fontFamilyId === "string" ? value.fontFamilyId : DEFAULT_SETTINGS.fontFamilyId,
    fontSize: clampNumber(value.fontSize, 11, 22, DEFAULT_SETTINGS.fontSize),
    lineHeight: clampNumber(value.lineHeight, 1.05, 1.6, DEFAULT_SETTINGS.lineHeight),
    cursorBlink: value.cursorBlink ?? DEFAULT_SETTINGS.cursorBlink,
    cursorShape: value.cursorShape === "bar" || value.cursorShape === "underline" ? value.cursorShape : "block",
    copyOnSelect: value.copyOnSelect ?? DEFAULT_SETTINGS.copyOnSelect,
    useResttyClipboard: value.useResttyClipboard ?? DEFAULT_SETTINGS.useResttyClipboard,
    touchSelectionMode: normalizeTouchSelectionMode(value.touchSelectionMode),
    terminalBackgroundEnabled: terminalBackgroundUrl
      ? value.terminalBackgroundEnabled ?? DEFAULT_SETTINGS.terminalBackgroundEnabled
      : false,
    terminalBackgroundUrl,
    terminalBackgroundOpacity: clampNumber(
      value.terminalBackgroundOpacity,
      0.05,
      0.8,
      DEFAULT_SETTINGS.terminalBackgroundOpacity,
    ),
    terminalBackgroundBlur: Math.round(
      clampNumber(value.terminalBackgroundBlur, 0, 24, DEFAULT_SETTINGS.terminalBackgroundBlur),
    ),
    scrollbackLimit: Math.round(
      clampNumber(value.scrollbackLimit, 1000, 100000, DEFAULT_SETTINGS.scrollbackLimit),
    ),
    outputBufferLimit: Math.round(
      clampNumber(value.outputBufferLimit, MIN_OUTPUT_BUFFER_LIMIT, MAX_OUTPUT_BUFFER_LIMIT, DEFAULT_SETTINGS.outputBufferLimit),
    ),
    autoRestartSessions: value.autoRestartSessions ?? DEFAULT_SETTINGS.autoRestartSessions,
    tabLayout: value.tabLayout === "vertical" ? "vertical" : DEFAULT_SETTINGS.tabLayout,
    debugMode: value.debugMode ?? DEFAULT_SETTINGS.debugMode,
    aiProvider: typeof value.aiProvider === "string" ? value.aiProvider : DEFAULT_SETTINGS.aiProvider,
    aiBaseUrl: typeof value.aiBaseUrl === "string" ? value.aiBaseUrl : DEFAULT_SETTINGS.aiBaseUrl,
    aiApiKey: typeof value.aiApiKey === "string" ? value.aiApiKey : DEFAULT_SETTINGS.aiApiKey,
    aiModel: typeof value.aiModel === "string" ? value.aiModel : DEFAULT_SETTINGS.aiModel,
  };
}

function normalizeInterfaceStyleId(value: unknown): InterfaceStyleId {
  return INTERFACE_STYLE_IDS.includes(value as InterfaceStyleId)
    ? value as InterfaceStyleId
    : DEFAULT_SETTINGS.interfaceStyleId;
}

function normalizeTerminalBackgroundUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || /[\r\n"'\\]/.test(trimmed)) return "";
  try {
    const url = new URL(trimmed, window.location.href);
    if (url.origin !== window.location.origin) return "";
    if (!/^\/api\/terminal-backgrounds\/[0-9a-f-]+\/file$/.test(url.pathname)) return "";
    return `${url.pathname}${url.search}`;
  } catch {
    return "";
  }
}

export function saveSettings(settings: Settings) {
  saveLocalSettings(settings);
  void saveRemoteSettings(settings);
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

function normalizeTouchSelectionMode(value: unknown): Settings["touchSelectionMode"] {
  return value === "drag" || value === "off" || value === "long-press"
    ? value
    : DEFAULT_SETTINGS.touchSelectionMode;
}

function normalizeCustomThemes(value: unknown): CustomTerminalTheme[] {
  if (!Array.isArray(value)) return [];
  const themes: CustomTerminalTheme[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const theme = item as Partial<CustomTerminalTheme>;
    const id = typeof theme.id === "string" ? theme.id.trim() : "";
    const label = typeof theme.label === "string" ? theme.label.trim() : "";
    const source = typeof theme.ghosttySource === "string" ? theme.ghosttySource.slice(0, MAX_CUSTOM_THEME_SOURCE_BYTES) : "";
    if (!id || !label || !source || seen.has(id)) continue;
    seen.add(id);
    themes.push({ id, label, ghosttySource: source });
  }
  return themes;
}
