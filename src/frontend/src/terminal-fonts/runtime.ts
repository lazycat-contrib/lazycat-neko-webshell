import type { ResttyFontHintTarget } from "restty";
import type { Terminal } from "restty/xterm";

import type { Settings } from "../types";

export type TerminalFontRuntimeSettings = Pick<Settings, "fontLigatures" | "fontHinting" | "fontHintTarget">;

type FontRuntimeApp = {
  setLigatures: (value: boolean) => void;
  setFontHinting: (value: boolean) => void;
  setFontHintTarget: (value: ResttyFontHintTarget) => void;
};

export function applyTerminalFontRuntimeOptions(term: Terminal | undefined, settings: TerminalFontRuntimeSettings) {
  const app = terminalRuntimeApp(term);
  if (!app) return;
  app.setLigatures(settings.fontLigatures);
  app.setFontHinting(settings.fontHinting);
  app.setFontHintTarget(settings.fontHintTarget as ResttyFontHintTarget);
}

function terminalRuntimeApp(term: Terminal | undefined): FontRuntimeApp | undefined {
  return term?.restty?.activePane()?.getRawPane().app;
}
