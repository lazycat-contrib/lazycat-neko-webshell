import type { TerminalPane } from "./types";
import {
  paneTerminalCanvas,
  paneTerminalImeInput as paneImeInput,
} from "./terminal-dom.ts";

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
  if (!pane || (event.target !== paneTerminalCanvas(pane) && event.target !== paneImeInput(pane))) {
    return false;
  }
  if (isImeProcessKeyEvent(event)) {
    // Restty's kitty key encoder can turn a Windows IME "Process" event's
    // physical KeyW code into a literal w before the composition commits.
    if (event.type === "keydown") focusPaneImeInput(pane);
    event.stopPropagation();
    return true;
  }
  if (event.type === "keyup" || !isPlainPrintableKeyEvent(event)) return false;
  return focusPaneImeInput(pane);
}

function isImeProcessKeyEvent(event: KeyboardEvent): boolean {
  const legacyEvent = event as KeyboardEvent & { which?: number };
  return event.key === "Process" || event.keyCode === 229 || legacyEvent.which === 229;
}

function isPlainPrintableKeyEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return false;
  return event.key.length === 1;
}
