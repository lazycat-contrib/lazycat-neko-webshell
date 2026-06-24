import type { MessageKey } from "../i18n";
import type { TerminalFontHintTarget } from "../types";

export type FontHintTargetOption = {
  id: TerminalFontHintTarget;
  labelKey: MessageKey;
};

export const FONT_HINT_TARGETS: FontHintTargetOption[] = [
  { id: "auto", labelKey: "hint.auto" },
  { id: "light", labelKey: "hint.light" },
  { id: "normal", labelKey: "hint.normal" },
];

export function normalizeFontHintTarget(value: unknown): TerminalFontHintTarget {
  return value === "light" || value === "normal" ? value : "auto";
}
