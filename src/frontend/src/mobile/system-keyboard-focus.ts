import type { TerminalPane } from "../types";
import { paneTerminalImeInput } from "../terminal-dom.ts";

export function reactivateSystemKeyboardInput(input: HTMLTextAreaElement): boolean {
  input.readOnly = false;
  if (document.activeElement === input) {
    input.blur();
  }
  input.focus({ preventScroll: true });
  return document.activeElement === input;
}

export function focusPaneSystemKeyboardInput(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneTerminalImeInput(pane);
  return input ? reactivateSystemKeyboardInput(input) : false;
}
