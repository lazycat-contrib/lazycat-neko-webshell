import type { TerminalPane } from "./types";

export type PaneTerminalDom = {
  canvas: HTMLCanvasElement;
  imeInput: HTMLTextAreaElement;
};

export function capturePaneTerminalDom(pane: TerminalPane, dom: PaneTerminalDom) {
  pane.terminalCanvas = dom.canvas;
  pane.terminalImeInput = dom.imeInput;
}

export function clearPaneTerminalDom(pane: TerminalPane) {
  pane.terminalCanvas = undefined;
  pane.terminalImeInput = undefined;
}

export function paneTerminalCanvas(pane: TerminalPane): HTMLCanvasElement | null {
  return pane.terminalCanvas ?? null;
}

export function paneTerminalImeInput(pane: TerminalPane): HTMLTextAreaElement | null {
  return pane.terminalImeInput ?? null;
}
