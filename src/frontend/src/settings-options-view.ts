import { FONT_PRESETS, THEMES } from "./config";
import type { MessageKey } from "./i18n";
import { builtInGhosttyThemes } from "./theme-registry";
import type { CustomTerminalTheme, FontPreset } from "./types";
import { escapeAttr, escapeHtml } from "./utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderFontFamilyOptions(uploadedFonts: FontPreset[], tr: Translate): string {
  const customOptions = uploadedFonts.map(
    (font) => `<option value="${escapeAttr(font.id)}">${escapeHtml(font.label)}</option>`,
  ).join("");
  return `
    <optgroup label="${escapeAttr(tr("font.builtIn"))}">
      ${FONT_PRESETS.map((font) => `<option value="${escapeAttr(font.id)}">${escapeHtml(font.label)}</option>`).join("")}
    </optgroup>
    <optgroup label="${escapeAttr(tr("font.uploaded"))}">
      ${customOptions || `<option disabled>${escapeHtml(tr("font.noUploaded"))}</option>`}
    </optgroup>
  `;
}

export function renderThemeSelectOptions(customThemes: CustomTerminalTheme[], tr: Translate): string {
  const recommended = THEMES.map(
    (theme) => `<option value="${escapeAttr(theme.id)}">${escapeHtml(theme.label)}</option>`,
  ).join("");
  const builtIn = builtInGhosttyThemes().map(
    (theme) => `<option value="${escapeAttr(theme.id)}">${escapeHtml(theme.label)}</option>`,
  ).join("");
  const custom = customThemes.map(
    (theme) => `<option value="${escapeAttr(theme.id)}">${escapeHtml(theme.label)}</option>`,
  ).join("");
  return `
    <optgroup label="${escapeAttr(tr("theme.recommended"))}">
      ${recommended}
    </optgroup>
    <optgroup label="${escapeAttr(tr("theme.builtIn"))}">
      ${builtIn}
    </optgroup>
    <optgroup label="${escapeAttr(tr("theme.custom"))}">
      ${custom || `<option disabled>${escapeHtml(tr("theme.noCustom"))}</option>`}
    </optgroup>
  `;
}
