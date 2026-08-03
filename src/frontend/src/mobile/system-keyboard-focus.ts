import type { TerminalPane } from "../types";
import { paneTerminalCanvas, paneTerminalImeInput } from "../terminal-dom.ts";

export function enableSystemKeyboardInput(input: HTMLTextAreaElement) {
  input.disabled = false;
  input.readOnly = false;
}

export function reactivateSystemKeyboardInput(input: HTMLTextAreaElement): boolean {
  enableSystemKeyboardInput(input);
  if (document.activeElement === input) {
    input.blur();
  }
  input.focus({ preventScroll: true });
  return document.activeElement === input;
}

export function deactivateSystemKeyboardInput(input: HTMLTextAreaElement): boolean {
  input.readOnly = true;
  input.disabled = true;
  if (document.activeElement === input) {
    input.blur();
  }
  return document.activeElement !== input;
}

export function focusPaneSystemKeyboardInput(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneTerminalImeInput(pane);
  return input ? reactivateSystemKeyboardInput(input) : false;
}

export function dismissPaneSystemKeyboardInput(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneTerminalImeInput(pane);
  return input ? deactivateSystemKeyboardInput(input) : false;
}

export function enablePaneSystemKeyboardInput(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneTerminalImeInput(pane);
  if (!input) return false;
  enableSystemKeyboardInput(input);
  return true;
}

export function isPaneSystemKeyboardInputFocused(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneTerminalImeInput(pane);
  return Boolean(
    input
    && !input.disabled
    && !input.readOnly
    && document.activeElement === input,
  );
}

export function focusPaneHardwareKeyboardInput(pane: TerminalPane | undefined): boolean {
  if (!pane) return false;
  const input = paneTerminalImeInput(pane);
  if (input) deactivateSystemKeyboardInput(input);
  const canvas = paneTerminalCanvas(pane);
  if (!(canvas instanceof HTMLElement)) return false;
  canvas.focus({ preventScroll: true });
  return document.activeElement === canvas;
}
