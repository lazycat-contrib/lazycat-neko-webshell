import type { TerminalPane } from "./types";
import { paneImeInput } from "./terminal-viewport";

export function focusPaneImeInput(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneImeInput(pane);
  if (!input) return false;
  if (document.activeElement !== input) {
    input.focus({ preventScroll: true });
  }
  return document.activeElement === input;
}

export function preparePaneImeForKeyboardEvent(
  pane: TerminalPane | undefined,
  event: KeyboardEvent,
): boolean {
  if (!pane || !isPlainPrintableKeyEvent(event)) return false;
  return focusPaneImeInput(pane);
}

function isPlainPrintableKeyEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1;
}
