import type { MessageKey } from "../i18n";
import type { TerminalPane, Tone } from "../types";

export type TerminalTransferProtocol = "zmodem" | "trzsz";
export type TerminalTransferDirection = "upload" | "download";

export type TerminalTransferProtocolSupport = {
  lrzsz: boolean;
  trzsz: boolean;
};

export type TerminalTransferStatus =
  | "idle"
  | "detecting"
  | "choosing-file"
  | "choosing-save"
  | "transferring"
  | "complete"
  | "failed"
  | "cancelled";

export type TerminalTransferState = {
  status: TerminalTransferStatus;
  protocol?: TerminalTransferProtocol;
  paneId?: string;
  direction?: TerminalTransferDirection;
  name?: string;
  size?: number;
  transferred?: number;
  cwd?: string;
  message?: string;
  updatedAt: number;
};

export type TerminalTransferTranslate = (
  key: MessageKey,
  values?: Record<string, string | number>,
) => string;

export type TerminalTransferOptions = {
  sendBytes: (pane: TerminalPane, bytes: Uint8Array) => boolean;
  writeTerminalBytes: (pane: TerminalPane, bytes: Uint8Array) => void;
  writeTerminalText: (pane: TerminalPane, text: string) => void;
  setHistoryRecording: (pane: TerminalPane, enabled: boolean) => void;
  tr: TerminalTransferTranslate;
  onState: (state: TerminalTransferState) => void;
  onNotify: (message: string, tone?: Tone) => void;
};

export function idleTransferState(): TerminalTransferState {
  return {
    status: "idle",
    updatedAt: Date.now(),
  };
}
