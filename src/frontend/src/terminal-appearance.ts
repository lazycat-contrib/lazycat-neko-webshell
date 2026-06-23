import type { GhosttyTheme } from "restty";

import type { CursorShape } from "./types";

type ThemeColor = NonNullable<GhosttyTheme["colors"]["background"]>;

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
