import { TrzszFilter } from "trzsz";

import type { TerminalPane } from "../types";
import { errorMessage } from "../utils";
import type { TerminalTransferOptions, TerminalTransferState } from "./types";

type TrzszDirection = "upload" | "download";

type PaneRuntime = {
  pane: TerminalPane;
  filter: TrzszFilter;
  signatureTail: string;
  transferActive: boolean;
  historySuppressed: boolean;
  syncTimer?: number;
  manualCancel: boolean;
};

const TRZSZ_SIGNATURE = "::TRZSZ:TRANSFER:";
const TRZSZ_DETECTION_RE = /::TRZSZ:TRANSFER:([SRD]):/;
const DETECTION_SETTLE_MS = 1800;

export function createTrzszTerminalTransfer(options: TerminalTransferOptions) {
  const runtimes = new Map<string, PaneRuntime>();
  let state: TerminalTransferState = idleState();

  function consumePaneOutput(pane: TerminalPane, bytes: Uint8Array): boolean {
    const runtime = runtimeForPane(pane);
    observeSignature(pane, runtime, bytes);
    try {
      runtime.filter.processServerOutput(bytes);
      scheduleSync(pane, runtime, 20);
    } catch (error) {
      failPaneTransfer(pane, runtime, error);
    }
    return true;
  }

  function consumePaneInput(pane: TerminalPane, text: string): boolean {
    const runtime = runtimes.get(pane.id);
    if (!runtime) return false;
    try {
      runtime.filter.processTerminalInput(text);
      scheduleSync(pane, runtime, 20);
      return true;
    } catch (error) {
      failPaneTransfer(pane, runtime, error);
      return true;
    }
  }

  function resetPane(pane: TerminalPane, message?: string) {
    const runtime = runtimes.get(pane.id);
    if (!runtime) return;
    stopRuntime(pane, runtime);
    runtimes.delete(pane.id);
    if (state.paneId === pane.id && isActiveStatus(state.status)) {
      setState({
        ...state,
        status: "failed",
        protocol: "trzsz",
        message: message || options.tr("status.terminalTransferFailed", { message: options.tr("status.socketError") }),
      });
    }
  }

  function cancelActiveTransfer() {
    const paneId = state.paneId;
    if (!paneId || state.protocol !== "trzsz") return false;
    const runtime = runtimes.get(paneId);
    if (!runtime) return false;
    runtime.manualCancel = true;
    runtime.transferActive = false;
    window.clearTimeout(runtime.syncTimer);
    runtime.syncTimer = undefined;
    if (runtime.filter.isTransferringFiles()) {
      runtime.filter.stopTransferringFiles();
    }
    const pane = findPaneByRuntimeId(paneId);
    if (pane) restoreHistory(pane, runtime);
    setState({
      ...state,
      status: "cancelled",
      protocol: "trzsz",
      message: options.tr("status.terminalTransferCancelled"),
    });
    options.onNotify(options.tr("status.terminalTransferCancelled"), "neutral");
    return true;
  }

  function isTransferring(pane: TerminalPane): boolean {
    const runtime = runtimes.get(pane.id);
    return Boolean(runtime?.transferActive || runtime?.filter.isTransferringFiles());
  }

  function setTerminalColumns(pane: TerminalPane, cols: number) {
    const runtime = runtimes.get(pane.id);
    if (!runtime || !Number.isFinite(cols)) return;
    runtime.filter.setTerminalColumns(Math.max(1, Math.trunc(cols)));
  }

  function currentState(): TerminalTransferState {
    return state;
  }

  function runtimeForPane(pane: TerminalPane): PaneRuntime {
    const existing = runtimes.get(pane.id);
    if (existing) return existing;
    const runtime: PaneRuntime = {
      pane,
      signatureTail: "",
      transferActive: false,
      historySuppressed: false,
      manualCancel: false,
      filter: new TrzszFilter({
        writeToTerminal: (output) => writeTerminalOutput(pane, output),
        sendToServer: (input) => {
          const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
          options.sendBytes(pane, bytes);
        },
        terminalColumns: pane.cols || pane.term?.cols || 80,
      }),
    };
    runtimes.set(pane.id, runtime);
    return runtime;
  }

  function writeTerminalOutput(pane: TerminalPane, output: string | ArrayBuffer | Uint8Array | Blob) {
    if (typeof output === "string") {
      options.writeTerminalText(pane, output);
      return;
    }
    if (output instanceof Uint8Array) {
      options.writeTerminalBytes(pane, output);
      return;
    }
    if (output instanceof ArrayBuffer) {
      options.writeTerminalBytes(pane, new Uint8Array(output));
      return;
    }
    void output.arrayBuffer().then((buffer) => options.writeTerminalBytes(pane, new Uint8Array(buffer)));
  }

  function observeSignature(pane: TerminalPane, runtime: PaneRuntime, bytes: Uint8Array) {
    if (runtime.transferActive || runtime.filter.isTransferringFiles()) return;
    const text = `${runtime.signatureTail}${asciiPreview(bytes)}`;
    runtime.signatureTail = text.slice(-96);
    const match = text.match(TRZSZ_DETECTION_RE);
    if (!match) return;
    const direction = directionFromMarker(match[1]);
    suppressHistory(pane, runtime);
    setState({
      status: "detecting",
      protocol: "trzsz",
      paneId: pane.id,
      direction,
      cwd: pane.workingDirectory,
      message: options.tr(direction === "upload" ? "status.trzszUploadDetected" : "status.trzszDownloadDetected"),
    });
    scheduleSync(pane, runtime, DETECTION_SETTLE_MS);
  }

  function scheduleSync(pane: TerminalPane, runtime: PaneRuntime, delayMs: number) {
    window.clearTimeout(runtime.syncTimer);
    runtime.syncTimer = window.setTimeout(() => syncTransferState(pane, runtime), delayMs);
  }

  function syncTransferState(pane: TerminalPane, runtime: PaneRuntime) {
    runtime.syncTimer = undefined;
    const active = runtime.filter.isTransferringFiles();
    if (active) {
      suppressHistory(pane, runtime);
      if (!runtime.transferActive) {
        runtime.transferActive = true;
        setState({
          status: "transferring",
          protocol: "trzsz",
          paneId: pane.id,
          direction: state.paneId === pane.id ? state.direction : undefined,
          name: "trzsz",
          cwd: pane.workingDirectory,
          message: options.tr("status.trzszTransferring"),
        });
        options.onNotify(options.tr("status.terminalTransferStarted", { protocol: protocolLabel("trzsz", options.tr) }));
      }
      scheduleSync(pane, runtime, 500);
      return;
    }
    if (runtime.transferActive) {
      runtime.transferActive = false;
      restoreHistory(pane, runtime);
      const cancelled = runtime.manualCancel;
      runtime.manualCancel = false;
      setState({
        status: cancelled ? "cancelled" : "complete",
        protocol: "trzsz",
        paneId: pane.id,
        direction: state.direction,
        name: "trzsz",
        cwd: pane.workingDirectory,
        message: cancelled
          ? options.tr("status.terminalTransferCancelled")
          : options.tr("status.terminalTransferComplete", { name: protocolLabel("trzsz", options.tr) }),
      });
      options.onNotify(
        cancelled
          ? options.tr("status.terminalTransferCancelled")
          : options.tr("status.terminalTransferComplete", { name: protocolLabel("trzsz", options.tr) }),
        cancelled ? "neutral" : "ok",
      );
      return;
    }
    if (state.protocol === "trzsz" && state.paneId === pane.id && state.status === "detecting") {
      restoreHistory(pane, runtime);
      setState({
        ...state,
        status: "cancelled",
        protocol: "trzsz",
        message: options.tr("status.terminalTransferCancelled"),
      });
    }
  }

  function stopRuntime(pane: TerminalPane, runtime: PaneRuntime) {
    window.clearTimeout(runtime.syncTimer);
    if (runtime.filter.isTransferringFiles()) {
      try {
        runtime.filter.stopTransferringFiles();
      } catch {
        // Ignore shutdown races.
      }
    }
    restoreHistory(pane, runtime);
  }

  function failPaneTransfer(pane: TerminalPane, runtime: PaneRuntime, error: unknown) {
    stopRuntime(pane, runtime);
    const message = options.tr("status.terminalTransferFailed", { message: errorMessage(error) });
    setState({
      status: "failed",
      protocol: "trzsz",
      paneId: pane.id,
      direction: state.direction,
      cwd: pane.workingDirectory,
      message,
    });
    options.onNotify(message, "error");
  }

  function suppressHistory(pane: TerminalPane, runtime: PaneRuntime) {
    if (runtime.historySuppressed) return;
    runtime.historySuppressed = true;
    options.setHistoryRecording(pane, false);
  }

  function restoreHistory(pane: TerminalPane, runtime: PaneRuntime) {
    if (!runtime.historySuppressed) return;
    runtime.historySuppressed = false;
    options.setHistoryRecording(pane, true);
  }

  function findPaneByRuntimeId(paneId: string): TerminalPane | undefined {
    return runtimes.get(paneId)?.pane;
  }

  function setState(next: Omit<TerminalTransferState, "updatedAt"> | TerminalTransferState) {
    state = { ...next, updatedAt: Date.now() };
    options.onState(state);
  }

  return {
    consumePaneOutput,
    consumePaneInput,
    resetPane,
    cancelActiveTransfer,
    isTransferring,
    setTerminalColumns,
    state: currentState,
  };
}

function idleState(): TerminalTransferState {
  return {
    status: "idle",
    updatedAt: Date.now(),
  };
}

function asciiPreview(bytes: Uint8Array): string {
  let text = "";
  const start = Math.max(0, bytes.length - 256);
  for (let index = start; index < bytes.length; index += 1) {
    const code = bytes[index] ?? 0;
    text += code >= 0x20 && code <= 0x7e ? String.fromCharCode(code) : " ";
  }
  return text.includes(TRZSZ_SIGNATURE) ? text : text.slice(-96);
}

function directionFromMarker(marker: string | undefined): TrzszDirection {
  return marker === "S" ? "download" : "upload";
}

function isActiveStatus(status: TerminalTransferState["status"]): boolean {
  return status === "detecting"
    || status === "choosing-file"
    || status === "choosing-save"
    || status === "transferring";
}

function protocolLabel(protocol: "trzsz", tr: TerminalTransferOptions["tr"]): string {
  return tr("terminalTransfer.protocolTrzsz");
}
