import {
  createBrowserTerminalTransfer,
  type BrowserTerminalTransferOptions,
} from "../../terminal-transfer";
import type { TerminalTransferProtocolSupport, TerminalTransferState } from "../../terminal-transfer/types";
import type { SessionBackendId, TerminalPane, Tone } from "../../types";

export type TerminalTransferControllerOptions =
  Omit<BrowserTerminalTransferOptions, "onState" | "onNotify" | "enabledProtocols"> & {
    isEnabled: () => boolean;
    enabledProtocols: () => TerminalTransferProtocolSupport;
    onStatus: (message: string, tone?: Tone) => void;
    onRender: () => void;
  };

export function createTerminalTransferController(options: TerminalTransferControllerOptions) {
  let renderFrame = 0;
  let state: TerminalTransferState = {
    status: "idle",
    updatedAt: Date.now(),
  };

  const transfer = createBrowserTerminalTransfer({
    sendBytes: options.sendBytes,
    writeTerminalBytes: options.writeTerminalBytes,
    writeTerminalText: options.writeTerminalText,
    setHistoryRecording: options.setHistoryRecording,
    enabledProtocols: options.enabledProtocols,
    tr: options.tr,
    onState: (next) => {
      state = next;
      scheduleRender();
    },
    onNotify: options.onStatus,
  });

  function consumePaneOutput(pane: TerminalPane, bytes: Uint8Array): boolean {
    if (!options.isEnabled() || !backendSupportsTerminalTransfer(pane.sessionBackend)) return false;
    return transfer.consumePaneOutput(pane, bytes);
  }

  function consumePaneInput(pane: TerminalPane, text: string): boolean {
    if (!options.isEnabled() || !backendSupportsTerminalTransfer(pane.sessionBackend)) return false;
    return transfer.consumePaneInput(pane, text);
  }

  function resetPane(pane: TerminalPane, message?: string) {
    transfer.resetPane(pane, message);
  }

  function cancel() {
    transfer.cancelActiveTransfer();
  }

  function resizePane(pane: TerminalPane, cols: number) {
    transfer.setPaneColumns(pane, cols);
  }

  function viewState(): TerminalTransferState {
    return state;
  }

  function scheduleRender() {
    if (renderFrame) return;
    renderFrame = window.requestAnimationFrame(() => {
      renderFrame = 0;
      options.onRender();
    });
  }

  return {
    consumePaneOutput,
    consumePaneInput,
    resetPane,
    cancel,
    resizePane,
    viewState,
  };
}

export function backendSupportsTerminalTransfer(backend: SessionBackendId | undefined): boolean {
  return backend === "webshell" || backend === "ssh";
}
