import { SYMBOLS_SOURCE } from "../config";
import type { FontPreset } from "../types";
import { normalizeLocalFontFamily } from "./options";

type LocalFontFaceData = {
  family?: string;
  fullName?: string;
  postscriptName?: string;
};

type LocalFontAccess = {
  queryLocalFonts?: () => Promise<LocalFontFaceData[]>;
};

const LOCAL_FONT_PREFIX = "local:";

export function localFontPresetId(family: string): string {
  return `${LOCAL_FONT_PREFIX}${encodeURIComponent(normalizeLocalFontFamily(family))}`;
}

export function isLocalFontPresetId(value: string): boolean {
  return value.startsWith(LOCAL_FONT_PREFIX);
}

export function localFontFamilyFromPresetId(value: string): string {
  if (!isLocalFontPresetId(value)) return "";
  try {
    return normalizeLocalFontFamily(decodeURIComponent(value.slice(LOCAL_FONT_PREFIX.length)));
  } catch {
    return "";
  }
}

export function localFontPreset(family: string): FontPreset | undefined {
  const normalized = normalizeLocalFontFamily(family);
  if (!normalized) return undefined;
  return {
    id: localFontPresetId(normalized),
    label: normalized,
    family: quoteFontFamily(normalized),
    resttySources: [
      {
        type: "local",
        matchers: [normalized],
        label: normalized,
        required: true,
      },
      SYMBOLS_SOURCE,
    ],
  };
}

export async function queryBrowserLocalFonts(): Promise<FontPreset[]> {
  const access = localFontAccess();
  if (!access.queryLocalFonts) {
    throw new Error("Local Font Access API is unavailable in this browser");
  }
  const faces = await access.queryLocalFonts();
  const families = Array.from(new Set(
    faces
      .map((face) => normalizeLocalFontFamily(face.family || face.fullName || face.postscriptName))
      .filter(Boolean),
  )).sort((left, right) => left.localeCompare(right));
  return families
    .map(localFontPreset)
    .filter((font): font is FontPreset => Boolean(font));
}

export function quoteFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}", ui-monospace, monospace`;
}

function localFontAccess(): LocalFontAccess {
  const globalAccess = globalThis as typeof globalThis & LocalFontAccess;
  const navigatorAccess = navigator as Navigator & LocalFontAccess;
  return {
    queryLocalFonts: globalAccess.queryLocalFonts ?? navigatorAccess.queryLocalFonts?.bind(navigatorAccess),
  };
}
