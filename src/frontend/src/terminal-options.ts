import type { ResttyFontHintTarget, ResttyFontSource } from "restty";
import { Terminal } from "restty/xterm";

import type { PaneTerminalTransport, TouchSelectionMode } from "./types";

type BeforeInputPayload = {
  text: string;
  source: string;
};

export type PaneTerminalOptions = {
  cols: number;
  rows: number;
  fontSize: number;
  fontLigatures: boolean;
  fontHinting: boolean;
  fontHintTarget: ResttyFontHintTarget;
  fontSources: ResttyFontSource[];
  scrollbackLimit: number;
  touchSelectionMode: TouchSelectionMode;
  transport: PaneTerminalTransport | undefined;
  beforeInput: (payload: BeforeInputPayload) => string | undefined;
  onGridSize: (cols: number, rows: number) => void;
};

export function createPaneTerminal(options: PaneTerminalOptions): Terminal {
  return new Terminal({
    cols: options.cols,
    rows: options.rows,
    createInitialPane: true,
    shortcuts: false,
    defaultContextMenu: false,
    paneStyles: {
      enabled: true,
      splitBackground: "var(--term-bg, #050a12)",
      paneBackground: "var(--term-bg, #050a12)",
      inactivePaneOpacity: 1,
      activePaneOpacity: 1,
      opacityTransitionMs: 0,
      dividerThicknessPx: 0,
    },
    searchUi: false,
    fontSources: options.fontSources,
    appOptions: {
      renderer: "auto",
      fontPreset: "none",
      fontSize: options.fontSize,
      ligatures: options.fontLigatures,
      fontHinting: options.fontHinting,
      fontHintTarget: options.fontHintTarget,
      autoResize: true,
      attachWindowEvents: true,
      attachCanvasEvents: true,
      touchSelectionMode: options.touchSelectionMode,
      touchSelectionLongPressMs: 450,
      touchSelectionMoveThresholdPx: 10,
      beforeInput: options.beforeInput,
      maxScrollbackBytes: Math.max(1_000_000, options.scrollbackLimit * 160),
      ptyTransport: options.transport,
      callbacks: {
        onGridSize: options.onGridSize,
      },
    },
  });
}
