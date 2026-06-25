import type { TerminalPane } from "../types";
import { createTrzszTerminalTransfer } from "./trzsz";
import type {
  TerminalTransferOptions,
  TerminalTransferProtocolSupport,
  TerminalTransferState,
} from "./types";
import { idleTransferState } from "./types";
import { createZmodemTerminalTransfer } from "./zmodem";

export type BrowserTerminalTransferOptions = TerminalTransferOptions & {
  enabledProtocols: () => TerminalTransferProtocolSupport;
};

export function createBrowserTerminalTransfer(options: BrowserTerminalTransferOptions) {
  let state: TerminalTransferState = idleTransferState();

  const trzsz = createTrzszTerminalTransfer({
    ...options,
    onState: setState,
  });

  const zmodem = createZmodemTerminalTransfer({
    sendBytes: options.sendBytes,
    writeTerminalBytes: (pane, bytes) => {
      if (options.enabledProtocols().trzsz) {
        trzsz.consumePaneOutput(pane, bytes);
      } else {
        options.writeTerminalBytes(pane, bytes);
      }
    },
    setHistoryRecording: options.setHistoryRecording,
    tr: options.tr,
    onNotify: options.onNotify,
    onState: setState,
  });

  function consumePaneOutput(pane: TerminalPane, bytes: Uint8Array): boolean {
    const protocols = options.enabledProtocols();
    if (!protocols.lrzsz && !protocols.trzsz) return false;
    if (protocols.lrzsz) {
      return zmodem.consumePaneOutput(pane, bytes);
    }
    if (protocols.trzsz) {
      return trzsz.consumePaneOutput(pane, bytes);
    }
    return false;
  }

  function consumePaneInput(pane: TerminalPane, text: string): boolean {
    const protocols = options.enabledProtocols();
    if (!protocols.trzsz) return false;
    if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying || pane.closing) return false;
    if (!trzsz.isTransferring(pane) && text === "\x03") return false;
    return trzsz.consumePaneInput(pane, text);
  }

  function resetPane(pane: TerminalPane, message?: string) {
    zmodem.resetPane(pane, message);
    trzsz.resetPane(pane, message);
  }

  function cancelActiveTransfer() {
    if (state.protocol === "trzsz" && trzsz.cancelActiveTransfer()) return;
    zmodem.cancelActiveTransfer();
  }

  function setPaneColumns(pane: TerminalPane, cols: number) {
    trzsz.setTerminalColumns(pane, cols);
  }

  function currentState(): TerminalTransferState {
    return state;
  }

  function setState(next: TerminalTransferState) {
    state = next;
    options.onState(next);
  }

  return {
    consumePaneOutput,
    consumePaneInput,
    resetPane,
    cancelActiveTransfer,
    setPaneColumns,
    state: currentState,
  };
}
