import type { PaneTerminalTransport, TerminalPane } from "./types";

export type PaneTransportHandlers = {
  updateSize: (pane: TerminalPane, cols: number, rows: number) => boolean;
  openSocket: (pane: TerminalPane) => void;
  sendInput: (pane: TerminalPane, data: string) => boolean;
  resize: (pane: TerminalPane, cols: number, rows: number) => boolean;
};

export function createPaneTransport(
  pane: TerminalPane,
  handlers: PaneTransportHandlers,
): PaneTerminalTransport {
  let callbacks: Parameters<PaneTerminalTransport["connect"]>[0]["callbacks"] | undefined;
  let connected = false;

  return {
    connect: (options) => {
      callbacks = options.callbacks;
      if (pane.closing) return;
      if (options.cols && options.rows) {
        handlers.updateSize(pane, options.cols, options.rows);
      }
      if (pane.socket?.readyState === WebSocket.OPEN) {
        connected = true;
        callbacks.onConnect?.();
        return;
      }
      if (pane.socket?.readyState === WebSocket.CONNECTING) return;
      handlers.openSocket(pane);
    },
    disconnect: () => {
      connected = false;
      pane.socket?.close();
      pane.socket = undefined;
    },
    sendInput: (data) => handlers.sendInput(pane, data),
    resize: (cols, rows) => handlers.resize(pane, cols, rows),
    isConnected: () => connected && pane.socket?.readyState === WebSocket.OPEN && !pane.closing && !pane.exited,
    destroy: () => {
      connected = false;
      callbacks = undefined;
      pane.socket?.close();
      pane.socket = undefined;
    },
    notifyConnect: () => {
      if (!callbacks) return;
      connected = true;
      callbacks?.onConnect?.();
    },
    notifyDisconnect: () => {
      connected = false;
      callbacks?.onDisconnect?.();
    },
    notifyData: (data) => {
      if (!data) return false;
      if (!callbacks?.onData) return false;
      callbacks.onData(data);
      return true;
    },
    notifyError: (message, errors) => {
      callbacks?.onError?.(message, errors);
    },
    notifyExit: (code) => {
      callbacks?.onExit?.(code);
    },
  };
}
