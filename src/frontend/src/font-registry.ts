import type { ResttyFontSource } from "restty";

import { CJK_FONT_SOURCE, FONT_PRESETS, PREINSTALLED_FONT_BASE } from "./config";
import type { FontPreset, StoredFont } from "./types";

export function resttyFontSourcesFor(font: FontPreset): ResttyFontSource[] {
  const sources = font.resttySources ?? FONT_PRESETS[0]?.resttySources ?? [];
  return [...sources, CJK_FONT_SOURCE].map(resolveResttyFontSource);
}

export function storedFontToResttyPreset(font: StoredFont): FontPreset | undefined {
  if (!font.id || !font.family || !font.url) return undefined;
  const label = font.label || font.family;
  return {
    id: `custom:${font.id}`,
    label,
    family: quoteFontFamily(font.family),
    resttySources: [
      { type: "url", url: new URL(font.url, window.location.href).toString(), label },
      {
        type: "url",
        url: `${PREINSTALLED_FONT_BASE}SymbolsNerdFontMono-Regular.ttf`,
        label: "Symbols Nerd Font Mono",
      },
    ],
    custom: true,
  };
}

function resolveResttyFontSource(source: ResttyFontSource): ResttyFontSource {
  if (source.type !== "url") return source;
  return {
    ...source,
    url: new URL(source.url, window.location.href).toString(),
  };
}

function quoteFontFamily(family: string): string {
  return `"${family.replace(/["\\]/g, "\\$&")}", ui-monospace, monospace`;
}
