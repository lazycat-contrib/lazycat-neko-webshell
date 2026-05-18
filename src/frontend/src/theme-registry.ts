import { getBuiltinTheme, listBuiltinThemeNames, parseGhosttyTheme, type GhosttyTheme } from "restty";

import { THEMES } from "./config";
import type { CustomTerminalTheme, TerminalTheme } from "./types";

const BUILTIN_THEME_PREFIX = "ghostty:";
export const CUSTOM_THEME_PREFIX = "custom-theme:";

export function resolveTheme(themeId: string, customThemes: CustomTerminalTheme[]): TerminalTheme {
  return allThemes(customThemes).find((item) => item.id === themeId) ?? THEMES[0];
}

export function allThemes(customThemes: CustomTerminalTheme[]): TerminalTheme[] {
  return [
    ...THEMES,
    ...builtInGhosttyThemes(),
    ...customThemes.map(customThemeToTerminalTheme),
  ];
}

export function builtInGhosttyThemes(): TerminalTheme[] {
  return listBuiltinThemeNames().map((name) => ({
    id: `${BUILTIN_THEME_PREFIX}${name}`,
    label: name,
    ghosttyName: name,
  }));
}

export function customThemeToTerminalTheme(theme: CustomTerminalTheme): TerminalTheme {
  return {
    id: theme.id,
    label: theme.label,
    ghosttySource: theme.ghosttySource,
    custom: true,
  };
}

export function resttyThemeFor(theme: TerminalTheme): GhosttyTheme | null {
  if (theme.ghosttySource) return parseGhosttyTheme(theme.ghosttySource);
  return getBuiltinTheme(theme.ghosttyName ?? "") ?? getBuiltinTheme("Ghostty Default Style Dark");
}

export function parseCustomGhosttyTheme(source: string): GhosttyTheme {
  return parseGhosttyTheme(source);
}
