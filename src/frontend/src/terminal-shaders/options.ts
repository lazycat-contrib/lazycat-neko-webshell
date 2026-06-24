import type { MessageKey } from "../i18n";
import type { TerminalShaderEffect } from "../types";

export type TerminalShaderEffectOption = {
  id: TerminalShaderEffect;
  labelKey: MessageKey;
};

export const TERMINAL_SHADER_EFFECTS: TerminalShaderEffectOption[] = [
  { id: "off", labelKey: "shader.off" },
  { id: "interactive-glow", labelKey: "shader.interactiveGlow" },
  { id: "soft-vignette", labelKey: "shader.softVignette" },
  { id: "scanline", labelKey: "shader.scanline" },
];

export function normalizeTerminalShaderEffect(value: unknown): TerminalShaderEffect {
  return value === "interactive-glow" || value === "soft-vignette" || value === "scanline"
    ? value
    : "off";
}
