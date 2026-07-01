import type { TerminalPane } from "./types";

export function applyPaneMouseMode(pane: TerminalPane) {
  pane.term?.restty?.setMouseMode(paneRequiresApplicationMouse(pane) ? "on" : "auto");
}

export function paneRoutesMouseToApplication(
  pane: TerminalPane,
  event: MouseEvent | PointerEvent,
): boolean {
  if (event.shiftKey) return false;
  if (paneRequiresApplicationMouse(pane)) return Boolean(pane.term?.restty);
  return Boolean(pane.term?.restty?.getMouseStatus().active);
}

function paneRequiresApplicationMouse(pane: TerminalPane): boolean {
  return pane.sessionBackend === "herdr" || pane.sessionBackend === "zellij";
}
