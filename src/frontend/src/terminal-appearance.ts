import type { GhosttyTheme } from "restty";

import { FONT_PRESETS, THEMES } from "./config";
import { resttyFontSourcesFor } from "./font-registry";
import { applyTerminalFontRuntimeOptions } from "./terminal-fonts";
import { resolveTheme, resttyThemeFor } from "./theme-registry";
import type { CursorShape, FontPreset, Settings, TerminalPane, TerminalTheme } from "./types";

type ThemeColor = NonNullable<GhosttyTheme["colors"]["background"]>;

type TerminalAppearanceSettings = Pick<
  Settings,
  | "cursorBlink"
  | "cursorShape"
  | "fontFamilyId"
  | "fontLigatures"
  | "fontHinting"
  | "fontHintTarget"
  | "fontSize"
  | "lineHeight"
  | "terminalBackgroundBlur"
  | "terminalBackgroundEnabled"
  | "terminalBackgroundOpacity"
  | "terminalBackgroundUrl"
  | "themeId"
  | "customThemes"
>;

export type TerminalAppearanceContext = {
  settings: TerminalAppearanceSettings;
  theme: TerminalTheme;
  font: FontPreset;
  resttyTheme: GhosttyTheme | null;
};

export function terminalAppearanceContext(
  settings: TerminalAppearanceSettings,
  customFonts: FontPreset[],
): TerminalAppearanceContext {
  const theme = currentTerminalTheme(settings);
  const font = currentTerminalFont(settings, customFonts);
  return {
    settings,
    theme,
    font,
    resttyTheme: resttyThemeFor(theme),
  };
}

export function currentTerminalTheme(settings: TerminalAppearanceSettings): TerminalTheme {
  return resolveTheme(settings.themeId, settings.customThemes);
}

export function currentTerminalFont(
  settings: Pick<Settings, "fontFamilyId">,
  customFonts: FontPreset[],
): FontPreset {
  return [...FONT_PRESETS, ...customFonts].find((item) => item.id === settings.fontFamilyId) ?? FONT_PRESETS[0];
}

export function cursorStyleSequence(shape: CursorShape, blink: boolean): string {
  if (shape === "bar") return `\x1b[${blink ? 5 : 6} q`;
  if (shape === "underline") return `\x1b[${blink ? 3 : 4} q`;
  return `\x1b[${blink ? 1 : 2} q`;
}

export function terminalThemeCssVars(theme: GhosttyTheme | null): Record<string, string> {
  const background = colorToCss(theme?.colors.background, "#050a12");
  const foreground = colorToCss(theme?.colors.foreground, "#edf2f7");
  const cursor = colorToCss(theme?.colors.cursor, foreground);
  const vars: Record<string, string> = {
    "--term-bg": background,
    "--term-fg": foreground,
    "--term-cursor": cursor,
  };

  const palette = theme?.colors.palette ?? [];
  for (let index = 0; index < 16; index += 1) {
    const color = palette[index];
    if (color) {
      vars[`--term-color-${index}`] = colorToCss(color, foreground);
    }
  }
  return vars;
}

export function applyThemeVariables(target: HTMLElement, resttyTheme: GhosttyTheme | null) {
  const vars = terminalThemeCssVars(resttyTheme);
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(name, value);
  }
}

export function applyThemeToMount(mount: HTMLElement, context: TerminalAppearanceContext) {
  const themeClasses = THEMES.map((item) => item.className).filter((value): value is string => Boolean(value));
  mount.classList.remove(...themeClasses);
  if (context.theme.className) {
    mount.classList.add(context.theme.className);
  }
  applyThemeVariables(mount, context.resttyTheme);
  mount.classList.remove("cursor-shape-block", "cursor-shape-bar", "cursor-shape-underline");
  mount.classList.add(`cursor-shape-${context.settings.cursorShape}`);
  mount.classList.toggle("cursor-blink", context.settings.cursorBlink);
  mount.style.setProperty("--term-font-family", context.font.family);
  mount.style.setProperty("--term-font-size", `${context.settings.fontSize}px`);
  mount.style.setProperty("--term-line-height", String(context.settings.lineHeight));
  applyTerminalBackgroundToMount(mount, context.settings);
}

export function applyTerminalAppearance(
  pane: TerminalPane,
  context: TerminalAppearanceContext,
  onFontLoadError?: (error: unknown) => void,
) {
  applyThemeToMount(pane.mount, context);
  const term = pane.term;
  if (!term?.restty) return;
  const hasBackground = terminalBackgroundActive(context.settings);
  const renderTheme = hasBackground ? withTransparentBackground(context.resttyTheme) : context.resttyTheme;
  if (renderTheme) {
    term.restty.applyTheme(renderTheme, context.theme.label);
  }
  const themeVars = terminalThemeCssVars(context.resttyTheme);
  term.restty.setPaneStyleOptions({
    splitBackground: hasBackground ? "transparent" : themeVars["--term-bg"],
    paneBackground: hasBackground ? "transparent" : themeVars["--term-bg"],
    inactivePaneOpacity: 1,
    activePaneOpacity: 1,
    opacityTransitionMs: 0,
    dividerThicknessPx: 1,
  });
  applyCursorAppearance(pane, context.settings);
  term.restty.setFontSize(context.settings.fontSize);
  applyTerminalFontRuntimeOptions(term, context.settings);
  void term.restty.setFonts(resttyFontSourcesFor(context.font)).catch((error: unknown) => {
    onFontLoadError?.(error);
  });
  term.restty.updateSize(true);
}

export function terminalBackgroundActive(settings: TerminalAppearanceSettings): boolean {
  return settings.terminalBackgroundEnabled && Boolean(settings.terminalBackgroundUrl);
}

export function applyTerminalBackgroundToMount(mount: HTMLElement, settings: TerminalAppearanceSettings) {
  const active = terminalBackgroundActive(settings);
  mount.classList.toggle("has-terminal-background", active);
  if (!active) {
    mount.style.removeProperty("--terminal-bg-image");
    mount.style.removeProperty("--terminal-bg-opacity");
    mount.style.removeProperty("--terminal-bg-blur");
    return;
  }
  mount.style.setProperty("--terminal-bg-image", `url(${JSON.stringify(settings.terminalBackgroundUrl)})`);
  mount.style.setProperty("--terminal-bg-opacity", String(settings.terminalBackgroundOpacity));
  mount.style.setProperty("--terminal-bg-blur", `${settings.terminalBackgroundBlur}px`);
}

export function applyCursorAppearance(
  pane: TerminalPane,
  settings: Pick<Settings, "cursorShape" | "cursorBlink">,
) {
  pane.term?.write(cursorStyleSequence(settings.cursorShape, settings.cursorBlink));
}

export function withTransparentBackground(theme: GhosttyTheme | null): GhosttyTheme | null {
  if (!theme) return theme;
  const background = theme.colors.background;
  if (!background) return theme;
  return {
    ...theme,
    colors: {
      ...theme.colors,
      background: {
        ...background,
        a: 0,
      },
      palette: [...theme.colors.palette],
    },
  };
}

function colorToCss(color: ThemeColor | undefined, fallback: string): string {
  if (!color) return fallback;
  const r = clampColorByte(color.r);
  const g = clampColorByte(color.g);
  const b = clampColorByte(color.b);
  if (color.a === undefined || color.a >= 255) {
    return `#${hexByte(r)}${hexByte(g)}${hexByte(b)}`;
  }
  return `rgba(${r}, ${g}, ${b}, ${clampColorByte(color.a) / 255})`;
}

function clampColorByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}
