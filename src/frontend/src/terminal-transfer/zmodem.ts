import Zmodem from "zmodem-ts";

import type { TerminalPane } from "../types";
import { errorMessage } from "../utils";
import type { TerminalTransferOptions, TerminalTransferState } from "./types";

type ZmodemDetection = {
  confirm: () => ZmodemSession;
  deny: () => void;
  get_session_role: () => ZmodemSessionRole;
  is_valid: () => boolean;
};

type ZmodemSessionRole = "receive" | "send";

type ZmodemSession = {
  type: ZmodemSessionRole;
  on: (event: string, callback: (...args: unknown[]) => void) => ZmodemSession;
  start?: () => Promise<unknown>;
  send_offer?: (params: {
    name: string;
    size?: number;
    mtime?: Date;
    files_remaining?: number;
    bytes_remaining?: number;
  }) => Promise<ZmodemTransfer | undefined>;
  close?: () => Promise<unknown>;
  abort: () => void;
};

type ZmodemOffer = {
  get_details: () => {
    name?: string;
    size?: number | null;
    mtime?: Date | number;
  };
  accept: (options?: { on_input?: (payload: number[] | Uint8Array) => void }) => Promise<unknown>;
  skip: () => Promise<unknown>;
};

type ZmodemTransfer = {
  send: (chunk: Uint8Array) => void;
  end: (chunk?: Uint8Array) => Promise<unknown>;
};

export type ZmodemTransferOptions = Omit<TerminalTransferOptions, "writeTerminalText">;

type PaneRuntime = {
  pane: TerminalPane;
  sentry: {
    consume: (bytes: Uint8Array) => void;
    get_confirmed_session: () => ZmodemSession | null;
  };
  activeSession?: ZmodemSession;
  historySuppressed: boolean;
};

type SaveTarget = {
  write: (chunk: Uint8Array) => Promise<void>;
  close: () => Promise<void>;
  abort: () => Promise<void>;
  fallbackDownload: boolean;
};

type SaveFilePickerWindow = Window & {
  showSaveFilePicker?: (options?: {
    suggestedName?: string;
    types?: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<{
    createWritable: () => Promise<{
      write: (chunk: Uint8Array) => Promise<void>;
      close: () => Promise<void>;
      abort?: () => Promise<void>;
    }>;
  }>;
};

const FILE_CHUNK_BYTES = 64 * 1024;

export function createZmodemTerminalTransfer(options: ZmodemTransferOptions) {
  const runtimes = new Map<string, PaneRuntime>();
  let state: TerminalTransferState = idleState();

  function consumePaneOutput(pane: TerminalPane, bytes: Uint8Array): boolean {
    const runtime = runtimeForPane(pane);
    try {
      runtime.sentry.consume(bytes);
    } catch (error) {
      failPaneTransfer(pane, error);
    }
    return true;
  }

  function resetPane(pane: TerminalPane, message?: string) {
    const runtime = runtimes.get(pane.id);
    if (!runtime) return;
    if (runtime.activeSession && !isEnded(runtime.activeSession)) {
      try {
        runtime.activeSession.abort();
      } catch {
        // The peer may already have closed the ZMODEM session.
      }
    }
    restoreHistory(pane, runtime);
    runtimes.delete(pane.id);
    if (state.paneId === pane.id && state.status === "transferring") {
      setState({
        status: "failed",
        protocol: "zmodem",
        paneId: pane.id,
        direction: state.direction,
        name: state.name,
        size: state.size,
        transferred: state.transferred,
        cwd: state.cwd,
        message: message || options.tr("status.zmodemTransferFailed", { message: options.tr("status.socketError") }),
      });
    }
  }

  function cancelActiveTransfer() {
    const paneId = state.paneId;
    if (!paneId) return;
    const runtime = runtimes.get(paneId);
    if (runtime?.activeSession && !isEnded(runtime.activeSession)) {
      try {
        runtime.activeSession.abort();
      } catch {
        // Ignore abort races.
      }
    }
    for (const [id, current] of runtimes) {
      if (id !== paneId) continue;
      current.activeSession = undefined;
      restoreHistory(current.pane, current);
    }
    setState({
      ...state,
      status: "cancelled",
      protocol: "zmodem",
      message: options.tr("status.zmodemTransferCancelled"),
    });
    options.onNotify(options.tr("status.zmodemTransferCancelled"), "neutral");
  }

  function currentState(): TerminalTransferState {
    return state;
  }

  function runtimeForPane(pane: TerminalPane): PaneRuntime {
    const existing = runtimes.get(pane.id);
    if (existing) return existing;
    const runtime: PaneRuntime = {
      pane,
      historySuppressed: false,
      sentry: new Zmodem.Sentry({
        to_terminal: (octets: number[] | Uint8Array) => {
          const bytes = toBytes(octets);
          if (bytes.length) options.writeTerminalBytes(pane, bytes);
        },
        sender: (octets: number[] | Uint8Array) => {
          options.sendBytes(pane, toBytes(octets));
        },
        on_detect: (detection: ZmodemDetection) => {
          void handleDetection(pane, runtime, detection);
        },
        on_retract: () => {
          if (state.paneId === pane.id && state.status === "detecting") {
            setState(idleState());
          }
        },
      }) as unknown as PaneRuntime["sentry"],
    };
    runtimes.set(pane.id, runtime);
    return runtime;
  }

  async function handleDetection(pane: TerminalPane, runtime: PaneRuntime, detection: ZmodemDetection) {
    if (!detection.is_valid()) return;
    const role = detection.get_session_role();
    setState({
      status: "detecting",
      protocol: "zmodem",
      paneId: pane.id,
      direction: role === "send" ? "upload" : "download",
      cwd: pane.workingDirectory,
      message: options.tr(role === "send" ? "status.zmodemUploadDetected" : "status.zmodemDownloadDetected"),
    });
    try {
      const session = detection.confirm();
      runtime.activeSession = session;
      suppressHistory(pane, runtime);
      session.on("session_end", () => {
        restoreHistory(pane, runtime);
        runtime.activeSession = undefined;
      });
      if (role === "send") {
        await sendFiles(pane, session);
      } else {
        await receiveFiles(pane, session);
      }
    } catch (error) {
      failPaneTransfer(pane, error);
    }
  }

  async function sendFiles(pane: TerminalPane, session: ZmodemSession) {
    if (!session.send_offer || !session.close) throw new Error("ZMODEM send session is unavailable");
    setState({
      status: "choosing-file",
      protocol: "zmodem",
      paneId: pane.id,
      direction: "upload",
      cwd: pane.workingDirectory,
      message: options.tr("status.zmodemChooseUploadFile"),
    });
    const files = await selectFiles();
    if (!files.length) {
      cancelSession(pane, session, options.tr("status.zmodemTransferCancelled"));
      return;
    }
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    let transferredTotal = 0;
    options.onNotify(options.tr("status.zmodemTransferStarted", { name: fileBatchLabel(files) }));
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      if (!file) continue;
      let sentForFile = 0;
      setState({
        status: "transferring",
        protocol: "zmodem",
        paneId: pane.id,
        direction: "upload",
        name: file.name,
        size: file.size,
        transferred: sentForFile,
        cwd: pane.workingDirectory,
        message: uploadDestinationMessage(pane, options.tr),
      });
      const transfer = await session.send_offer({
        name: file.name,
        size: file.size,
        mtime: file.lastModified ? new Date(file.lastModified) : undefined,
        ...remainingOfferParams(files, index, totalBytes, transferredTotal, file.size),
      });
      if (!transfer) {
        transferredTotal += file.size;
        continue;
      }
      await streamFile(file, async (chunk) => {
        transfer.send(chunk);
        sentForFile += chunk.byteLength;
        transferredTotal += chunk.byteLength;
        setState({
          ...state,
          status: "transferring",
          transferred: sentForFile,
          size: file.size,
        });
      });
      await transfer.end();
    }
    await session.close();
    completeTransfer(pane, "upload", fileBatchLabel(files), totalBytes);
  }

  async function receiveFiles(pane: TerminalPane, session: ZmodemSession) {
    if (!session.start) throw new Error("ZMODEM receive session is unavailable");
    session.on("offer", (rawOffer: unknown) => {
      void receiveOffer(pane, session, rawOffer as ZmodemOffer);
    });
    await session.start();
  }

  async function receiveOffer(pane: TerminalPane, session: ZmodemSession, offer: ZmodemOffer) {
    const details = offer.get_details();
    const name = safeFileName(details.name || "download");
    const size = normalizeSize(details.size);
    setState({
      status: "choosing-save",
      protocol: "zmodem",
      paneId: pane.id,
      direction: "download",
      name,
      size,
      transferred: 0,
      cwd: pane.workingDirectory,
      message: options.tr("status.zmodemChooseSaveLocation", { name }),
    });
    const target = await createSaveTarget(name);
    if (!target) {
      try {
        await offer.skip();
      } catch {
        session.abort();
      }
      cancelSession(pane, session, options.tr("status.zmodemTransferCancelled"));
      return;
    }
    let transferred = 0;
    setState({
      status: "transferring",
      protocol: "zmodem",
      paneId: pane.id,
      direction: "download",
      name,
      size,
      transferred,
      cwd: pane.workingDirectory,
      message: target.fallbackDownload
        ? options.tr("status.zmodemReceivingFallback")
        : options.tr("status.zmodemReceiving"),
    });
    options.onNotify(options.tr("status.zmodemTransferStarted", { name }));
    try {
      let writeQueue = Promise.resolve();
      await offer.accept({
        on_input: (payload) => {
          const chunk = toBytes(payload);
          transferred += chunk.byteLength;
          writeQueue = writeQueue.then(() => target.write(chunk));
          setState({
            ...state,
            status: "transferring",
            transferred,
            size,
          });
        },
      });
      await writeQueue;
      await target.close();
      completeTransfer(pane, "download", name, transferred || size);
    } catch (error) {
      await target.abort();
      throw error;
    }
  }

  function completeTransfer(
    pane: TerminalPane,
    direction: "upload" | "download",
    name: string,
    transferred: number | undefined,
  ) {
    const runtime = runtimes.get(pane.id);
    if (runtime) restoreHistory(pane, runtime);
    setState({
      status: "complete",
      protocol: "zmodem",
      paneId: pane.id,
      direction,
      name,
      size: transferred,
      transferred,
      cwd: pane.workingDirectory,
      message: options.tr("status.zmodemTransferComplete", { name }),
    });
    options.onNotify(options.tr("status.zmodemTransferComplete", { name }), "ok");
  }

  function cancelSession(pane: TerminalPane, session: ZmodemSession, message: string) {
    try {
      session.abort();
    } catch {
      // Ignore abort races.
    }
    const runtime = runtimes.get(pane.id);
    if (runtime) restoreHistory(pane, runtime);
    setState({
      status: "cancelled",
      protocol: "zmodem",
      paneId: pane.id,
      direction: state.direction,
      name: state.name,
      size: state.size,
      transferred: state.transferred,
      cwd: pane.workingDirectory,
      message,
    });
    options.onNotify(message, "neutral");
  }

  function failPaneTransfer(pane: TerminalPane, error: unknown) {
    const runtime = runtimes.get(pane.id);
    if (runtime) {
      restoreHistory(pane, runtime);
      runtime.activeSession = undefined;
    }
    const message = options.tr("status.zmodemTransferFailed", { message: errorMessage(error) });
    setState({
      status: "failed",
      protocol: "zmodem",
      paneId: pane.id,
      direction: state.direction,
      name: state.name,
      size: state.size,
      transferred: state.transferred,
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

  function setState(next: Omit<TerminalTransferState, "updatedAt"> | TerminalTransferState) {
    state = { ...next, updatedAt: Date.now() };
    options.onState(state);
  }

  return {
    consumePaneOutput,
    resetPane,
    cancelActiveTransfer,
    state: currentState,
  };
}

function idleState(): TerminalTransferState {
  return {
    status: "idle",
    updatedAt: Date.now(),
  };
}

function toBytes(value: number[] | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function normalizeSize(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isEnded(session: ZmodemSession): boolean {
  return Boolean((session as unknown as { has_ended?: () => boolean }).has_ended?.());
}

function safeFileName(name: string): string {
  return name.trim().split(/[\\/]/).filter(Boolean).pop()?.replace(/[\x00-\x1f\x7f]/g, "") || "download";
}

function fileBatchLabel(files: File[]): string {
  if (files.length === 1) return files[0]?.name ?? "file";
  return `${files.length} files`;
}

function uploadDestinationMessage(pane: TerminalPane, tr: ZmodemTransferOptions["tr"]): string {
  return pane.workingDirectory
    ? tr("status.zmodemUploadingTo", { path: pane.workingDirectory })
    : tr("status.zmodemUploadingToCurrentDirectory");
}

function remainingOfferParams(
  files: File[],
  index: number,
  totalBytes: number,
  transferredTotal: number,
  fileSize: number,
): { files_remaining?: number; bytes_remaining?: number } {
  const filesRemaining = files.length - index - 1;
  if (filesRemaining <= 0) return {};
  return {
    files_remaining: filesRemaining,
    bytes_remaining: Math.max(0, totalBytes - transferredTotal - fileSize),
  };
}

async function selectFiles(): Promise<File[]> {
  return await new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      const files = Array.from(input.files ?? []);
      input.remove();
      resolve(files);
    };
    input.addEventListener("change", finish, { once: true });
    input.addEventListener("cancel", finish, { once: true });
    window.addEventListener("focus", () => window.setTimeout(finish, 250), { once: true });
    document.body.append(input);
    input.click();
  });
}

async function streamFile(file: File, onChunk: (chunk: Uint8Array) => Promise<void> | void) {
  if (file.stream) {
    const reader = file.stream().getReader();
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        await onChunk(result.value);
      }
    } finally {
      reader.releaseLock();
    }
    return;
  }
  for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
    const chunk = new Uint8Array(await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
    await onChunk(chunk);
  }
}

async function createSaveTarget(name: string): Promise<SaveTarget | undefined> {
  const picker = (window as SaveFilePickerWindow).showSaveFilePicker;
  if (picker) {
    try {
      const handle = await picker({
        suggestedName: name,
      });
      const writable = await handle.createWritable();
      return {
        fallbackDownload: false,
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
        abort: async () => {
          if (writable.abort) await writable.abort();
        },
      };
    } catch (error) {
      if (isUserCancel(error)) return undefined;
      throw error;
    }
  }

  const chunks: ArrayBuffer[] = [];
  return {
    fallbackDownload: true,
    write: async (chunk) => {
      chunks.push(copyChunkBuffer(chunk));
    },
    close: async () => {
      const blob = new Blob(chunks, { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.rel = "noreferrer";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
    abort: async () => {
      chunks.length = 0;
    },
  };
}

function copyChunkBuffer(chunk: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(chunk.byteLength);
  copy.set(chunk);
  return copy.buffer;
}

function isUserCancel(error: unknown): boolean {
  return error instanceof DOMException && (error.name === "AbortError" || error.name === "NotAllowedError");
}
