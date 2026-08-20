import type { PaneTerminalTransport, TerminalPane } from "./types";
import { clearPaneTerminalDom } from "./terminal-dom";

export type PaneTransportFactory = (pane: TerminalPane) => PaneTerminalTransport;

export function replacePaneTransport(
  pane: TerminalPane,
  createTransport: PaneTransportFactory,
): PaneTerminalTransport {
  destroyPaneTransport(pane);
  pane.transport = createTransport(pane);
  return pane.transport;
}

export function destroyPaneTransport(pane: TerminalPane) {
  const socket = pane.socket;
  pane.transport?.destroy();
  pane.transport = undefined;
  socket?.close();
  pane.socket = undefined;
}

export function disposePaneTerminalRuntime(pane: TerminalPane) {
  pane.remoteClipboardRetryDispose?.();
  pane.remoteClipboardRetryDispose = undefined;
  pane.remoteClipboardRetryClear = undefined;
  pane.touchKeyboardGuardDispose?.();
  pane.touchKeyboardGuardDispose = undefined;
  pane.touchKeyboardGuardInstalled = false;
  try {
    pane.term?.restty?.disconnectPty();
  } catch {
    // Restty may already be half-disposed during tab teardown.
  }
  pane.term?.dispose();
  pane.term = undefined;
  clearPaneTerminalDom(pane);
  pane.terminalShaderEffect = undefined;
}
