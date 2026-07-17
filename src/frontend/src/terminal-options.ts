import type { ResttyFontHintTarget, ResttyFontInput } from "restty";
import { Terminal } from "restty/xterm";

import type { NativePaneContextMenuItem } from "./pane-menu-actions";
import type { PaneTerminalDom } from "./terminal-dom";
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
  fonts: ResttyFontInput[];
  scrollbackLimit: number;
  touchSelectionMode: TouchSelectionMode;
  transport: PaneTerminalTransport | undefined;
  forwardTerminalReplies?: boolean;
  beforeInput: (payload: BeforeInputPayload) => string | undefined;
  contextMenuItems: () => Array<NativePaneContextMenuItem | "separator">;
  searchClearButtonText: string;
  searchPlaceholder: string;
  onDomReady: (dom: PaneTerminalDom) => void;
  onGridSize: (cols: number, rows: number) => void;
};

export function createPaneTerminal(options: PaneTerminalOptions): Terminal {
  const term = new Terminal({
    cols: options.cols,
    rows: options.rows,
    surface: {
      createInitialPane: true,
      shortcuts: false,
      defaultContextMenu: false,
      contextMenu: {
        getItems: () => options.contextMenuItems(),
      },
      paneStyles: {
        enabled: true,
        splitBackground: "var(--term-bg, #050a12)",
        paneBackground: "var(--term-bg, #050a12)",
        inactivePaneOpacity: 1,
        activePaneOpacity: 1,
        opacityTransitionMs: 0,
        dividerThicknessPx: 0,
      },
      searchUi: {
        placeholder: options.searchPlaceholder,
        clearButtonText: options.searchClearButtonText,
        shortcut: true,
        styles: {
          panelBackground: "var(--surface-raised)",
          panelBorderColor: "var(--line-strong)",
          panelTextColor: "var(--text)",
          inputBackground: "var(--input-bg)",
          inputTextColor: "var(--text)",
          inputPlaceholderColor: "var(--muted)",
          buttonBackground: "var(--surface-2)",
          buttonTextColor: "var(--text)",
          buttonHoverBackground: "var(--accent-soft)",
          statusTextColor: "var(--muted)",
          statusActiveTextColor: "var(--accent-fg)",
          statusCompleteTextColor: "var(--muted)",
        },
      },
    },
    terminal: (context) => {
      options.onDomReady({ canvas: context.canvas, imeInput: context.imeInput });
      return {
        renderer: "auto",
        fonts: options.fonts,
        fontSize: options.fontSize,
        fontSizeMode: "em",
        ligatures: options.fontLigatures,
        fontHinting: options.fontHinting,
        fontHintTarget: options.fontHintTarget,
        autoResize: true,
        showResizeOverlay: false,
        forwardTerminalReplies: options.forwardTerminalReplies ?? true,
        attachWindowEvents: true,
        attachCanvasEvents: true,
        touchSelectionMode: options.touchSelectionMode,
        touchSelectionLongPressMs: 450,
        touchSelectionMoveThresholdPx: 10,
        maxScrollbackBytes: Math.max(1_000_000, options.scrollbackLimit * 160),
      };
    },
    services: {
      beforeInput: options.beforeInput,
      ptyTransport: options.transport,
    },
  });
  term.onResize(({ cols, rows }) => options.onGridSize(cols, rows));
  return term;
}
