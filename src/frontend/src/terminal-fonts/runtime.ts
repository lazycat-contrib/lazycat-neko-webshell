import type { ResttyFontHintTarget } from "restty";
import type { Terminal } from "restty/xterm";

import type { Settings } from "../types";

export type TerminalFontRuntimeSettings = Pick<Settings, "fontLigatures" | "fontHinting" | "fontHintTarget">;

export function applyTerminalFontRuntimeOptions(term: Terminal | undefined, settings: TerminalFontRuntimeSettings) {
  const pane = term?.restty?.activePane();
  if (!pane) return;
  pane.setLigatures(settings.fontLigatures);
  pane.setFontHinting(settings.fontHinting);
  pane.setFontHintTarget(settings.fontHintTarget as ResttyFontHintTarget);
}
