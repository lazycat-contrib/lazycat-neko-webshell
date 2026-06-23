import {
  DEFAULT_SETTINGS,
  FONT_EXTENSIONS,
  FONT_MIME_TYPES,
  INTERFACE_STYLE_IDS,
  MAX_FONT_BYTES,
  MAX_TERMINAL_BACKGROUND_BYTES,
  TERMINAL_BACKGROUND_EXTENSIONS,
  TERMINAL_BACKGROUND_MIME_TYPES,
} from "./config";
import type { MessageKey } from "./i18n";
import { parseCustomGhosttyTheme } from "./theme-registry";
import type { InterfaceStyleId } from "./types";
import { errorMessage } from "./utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

const LIGHT_INTERFACE_STYLES = new Set<InterfaceStyleId>(["porcelain", "frost", "champagne", "candy", "lab"]);

export function normalizeInterfaceStyleId(value: string): InterfaceStyleId {
  return INTERFACE_STYLE_IDS.includes(value as InterfaceStyleId)
    ? value as InterfaceStyleId
    : DEFAULT_SETTINGS.interfaceStyleId;
}

export function isLightInterfaceStyle(value: InterfaceStyleId): boolean {
  return LIGHT_INTERFACE_STYLES.has(value);
}

export function normalizeHexColorInput(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

export function validateGhosttyThemeSource(
  source: string,
  tr: Translate,
): { ok: true } | { ok: false; message: string } {
  if (!source || !/(^|\n)\s*(background|foreground|palette)\s*=/.test(source)) {
    return { ok: false, message: tr("validation.themeSource") };
  }
  try {
    const theme = parseCustomGhosttyTheme(source);
    if (!theme.colors.background && !theme.colors.foreground && !theme.colors.palette.some(Boolean)) {
      return { ok: false, message: tr("validation.themeSource") };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

export function validateFontFile(file: File, tr: Translate) {
  const lowerName = file.name.toLowerCase();
  if (!FONT_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(tr("validation.fontExtension"));
  }
  if (file.type && !FONT_MIME_TYPES.has(file.type)) {
    throw new Error(tr("validation.fontMime", { mimeType: file.type }));
  }
  if (file.size <= 0 || file.size > MAX_FONT_BYTES) {
    throw new Error(tr("validation.fontSize"));
  }
}

export function mimeTypeForFont(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".woff2")) return "font/woff2";
  if (lowerName.endsWith(".woff")) return "font/woff";
  if (lowerName.endsWith(".ttf")) return "font/ttf";
  if (lowerName.endsWith(".otf")) return "font/otf";
  return "application/octet-stream";
}

export function validateTerminalBackgroundFile(file: File, tr: Translate) {
  const lowerName = file.name.toLowerCase();
  if (!TERMINAL_BACKGROUND_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(tr("validation.backgroundExtension"));
  }
  if (file.type && !TERMINAL_BACKGROUND_MIME_TYPES.has(file.type)) {
    throw new Error(tr("validation.backgroundMime", { mimeType: file.type }));
  }
  if (file.size <= 0 || file.size > MAX_TERMINAL_BACKGROUND_BYTES) {
    throw new Error(tr("validation.backgroundSize"));
  }
}

export function mimeTypeForTerminalBackground(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

export function terminalBackgroundIdFromUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) return "";
    const match = url.pathname.match(/^\/api\/terminal-backgrounds\/([0-9a-f-]+)\/file$/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}
