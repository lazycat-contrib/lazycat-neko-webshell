import type { PaneTerminalTransport, TerminalPane } from "./types";

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
  try {
    pane.term?.restty?.disconnectPty();
  } catch {
    // Restty may already be half-disposed during tab teardown.
  }
  pane.term?.dispose();
  pane.term = undefined;
  pane.terminalShaderEffect = undefined;
}
