import type { GhosttyTheme } from "restty";

type ThemeColor = NonNullable<GhosttyTheme["colors"]["background"]>;

export type TerminalThemeSocketColors = {
  foreground: string;
  background: string;
  cursor: string;
};

export function terminalThemeSocketColors(
  theme: GhosttyTheme | null,
): TerminalThemeSocketColors {
  const foreground = colorToHex(theme?.colors.foreground, "#edf2f7");
  return {
    foreground,
    background: colorToHex(theme?.colors.background, "#050a12"),
    cursor: colorToHex(theme?.colors.cursor, foreground),
  };
}

function colorToHex(color: ThemeColor | undefined, fallback: string): string {
  if (!color) return fallback;
  return `#${hexByte(color.r)}${hexByte(color.g)}${hexByte(color.b)}`;
}

function hexByte(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
}
