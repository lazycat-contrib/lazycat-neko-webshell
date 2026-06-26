import type { MessageKey } from "../../i18n";
import { formatFileSize } from "../../remote-files";
import type { TerminalTransferProtocolSupport, TerminalTransferState } from "../../terminal-transfer/types";
import type { SessionBackendId } from "../../types";
import { escapeAttr, escapeHtml } from "../../utils";
import { backendSupportsTerminalTransfer } from "./controller";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type TerminalTransferToolViewState = {
  disabled: boolean;
  activeBackend?: SessionBackendId;
  protocols: TerminalTransferProtocolSupport;
  state: TerminalTransferState;
  tr: Translate;
};

export function renderTerminalTransferToolView(state: TerminalTransferToolViewState): string {
  const tr = state.tr;
  const unsupported = state.activeBackend && !backendSupportsTerminalTransfer(state.activeBackend);
  const disabledAttr = state.disabled ? "disabled" : "";
  return `
    <div class="plugin-tool terminal-transfer-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(tr("plugin.terminalTransfer.name"))}</div>
          <p class="settings-help">${escapeHtml(unsupported ? tr("status.terminalTransferUnsupportedBackend") : tr("plugin.terminalTransfer.help"))}</p>
        </div>
      </div>
      ${unsupported ? renderUnsupported(state) : renderTransferState(state, disabledAttr)}
    </div>
  `;
}

function renderUnsupported(state: TerminalTransferToolViewState): string {
  return `
    <div class="terminal-transfer-state" data-status="failed">
      <span class="terminal-transfer-state-icon"><i data-lucide="circle-alert"></i></span>
      <div>
        <strong>${escapeHtml(state.tr("status.terminalTransferUnsupportedBackend"))}</strong>
        <p>${escapeHtml(state.tr("plugin.terminalTransfer.help"))}</p>
      </div>
    </div>
  `;
}

function renderTransferState(state: TerminalTransferToolViewState, disabledAttr: string): string {
  const transfer = state.state;
  const tr = state.tr;
  const title = statusTitle(transfer.status, tr);
  const progress = progressPercent(transfer);
  const active = transfer.status === "transferring"
    || transfer.status === "choosing-file"
    || transfer.status === "choosing-save"
    || transfer.status === "detecting";
  return `
    <div class="terminal-transfer-state" data-status="${escapeAttr(transfer.status)}">
      <span class="terminal-transfer-state-icon"><i data-lucide="${escapeAttr(statusIcon(transfer.status))}"></i></span>
      <div>
        <strong>${escapeHtml(title)}</strong>
        <p>${escapeHtml(transfer.message || readyMessage(state.protocols, tr))}</p>
      </div>
    </div>
    ${transfer.name || transfer.direction || transfer.protocol ? `
      <dl class="terminal-transfer-details">
        ${transfer.protocol ? detailRow(tr("field.terminalTransferProtocol"), protocolLabel(transfer.protocol, tr)) : ""}
        ${transfer.direction ? detailRow(tr("field.zmodemDirection"), transfer.direction === "upload" ? tr("zmodem.directionUpload") : tr("zmodem.directionDownload")) : ""}
        ${transfer.name ? detailRow(tr("field.zmodemFile"), transfer.name) : ""}
        ${transfer.cwd ? detailRow(tr("field.zmodemDestination"), transfer.cwd) : ""}
        ${typeof transfer.size === "number" ? detailRow(tr("field.zmodemSize"), formatFileSize(transfer.size)) : ""}
      </dl>
    ` : ""}
    <div class="terminal-transfer-progress" aria-label="${escapeAttr(tr("plugin.terminalTransfer.output"))}">
      <span style="width:${escapeAttr(String(progress))}%"></span>
    </div>
    <div class="terminal-transfer-progress-text">
      <span>${escapeHtml(progressText(transfer, state.protocols, tr))}</span>
      ${active ? `
        <button class="command-button danger" type="button" data-terminal-transfer-action="cancel" ${disabledAttr}>
          <i data-lucide="x"></i>
          <span>${escapeHtml(tr("action.zmodemCancel"))}</span>
        </button>
      ` : ""}
    </div>
  `;
}

function detailRow(label: string, value: string): string {
  return `
    <div>
      <dt>${escapeHtml(label)}</dt>
      <dd title="${escapeAttr(value)}">${escapeHtml(value)}</dd>
    </div>
  `;
}

function statusTitle(status: TerminalTransferState["status"], tr: Translate): string {
  if (status === "detecting") return tr("status.terminalTransferDetecting");
  if (status === "choosing-file") return tr("status.zmodemChooseUploadFile");
  if (status === "choosing-save") return tr("status.zmodemChooseSaveLocationShort");
  if (status === "transferring") return tr("status.zmodemTransferring");
  if (status === "complete") return tr("status.zmodemComplete");
  if (status === "failed") return tr("status.zmodemFailed");
  if (status === "cancelled") return tr("status.zmodemCancelled");
  return tr("status.terminalTransferReady");
}

function statusIcon(status: TerminalTransferState["status"]): string {
  if (status === "complete") return "circle-check";
  if (status === "failed") return "circle-alert";
  if (status === "cancelled") return "circle-slash";
  if (status === "transferring") return "arrow-left-right";
  if (status === "choosing-file" || status === "choosing-save") return "mouse-pointer-click";
  if (status === "detecting") return "radar";
  return "radio";
}

function progressPercent(state: TerminalTransferState): number {
  if (state.status === "complete") return 100;
  if (typeof state.size !== "number" || state.size <= 0 || typeof state.transferred !== "number") {
    return state.status === "transferring" ? 35 : 0;
  }
  return Math.max(0, Math.min(100, Math.round((state.transferred / state.size) * 100)));
}

function progressText(state: TerminalTransferState, protocols: TerminalTransferProtocolSupport, tr: Translate): string {
  if (state.status === "idle") return readyMessage(protocols, tr);
  if (state.protocol === "trzsz" && state.status === "transferring") return tr("status.trzszProgressInTerminal");
  if (typeof state.transferred !== "number") return state.message || statusTitle(state.status, tr);
  const transferred = formatFileSize(state.transferred);
  const total = typeof state.size === "number" ? formatFileSize(state.size) : "";
  return total ? `${transferred} / ${total}` : transferred;
}

function readyMessage(protocols: TerminalTransferProtocolSupport, tr: Translate): string {
  if (protocols.lrzsz && protocols.trzsz) return tr("status.terminalTransferReady");
  if (protocols.lrzsz) return tr("status.terminalTransferReadyLrzsz");
  if (protocols.trzsz) return tr("status.terminalTransferReadyTrzsz");
  return tr("status.terminalTransferNoProtocol");
}

function protocolLabel(protocol: TerminalTransferState["protocol"], tr: Translate): string {
  if (protocol === "trzsz") return tr("terminalTransfer.protocolTrzsz");
  return tr("terminalTransfer.protocolLrzsz");
}
