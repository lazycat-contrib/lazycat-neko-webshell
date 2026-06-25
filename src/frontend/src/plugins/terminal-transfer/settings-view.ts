import type { MessageKey } from "../../i18n";
import type { TerminalTransferProtocolSupport } from "../../terminal-transfer/types";
import { escapeAttr, escapeHtml } from "../../utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type TerminalTransferSettingsViewState = {
  protocols: TerminalTransferProtocolSupport;
  disabled: boolean;
  tr: Translate;
};

export function renderTerminalTransferSettingsView(state: TerminalTransferSettingsViewState): string {
  return `
    <div class="plugin-tool terminal-transfer-settings">
      <div class="settings-group-title">${escapeHtml(state.tr("terminalTransfer.protocolsTitle"))}</div>
      <p class="settings-help">${escapeHtml(state.tr("terminalTransfer.protocolsHelp"))}</p>
      <div class="terminal-transfer-protocol-options">
        ${protocolCheckbox("lrzsz", state.protocols.lrzsz, state)}
        ${protocolCheckbox("trzsz", state.protocols.trzsz, state)}
      </div>
    </div>
  `;
}

function protocolCheckbox(
  protocol: "lrzsz" | "trzsz",
  checked: boolean,
  state: TerminalTransferSettingsViewState,
): string {
  const label = protocol === "lrzsz"
    ? state.tr("terminalTransfer.protocolLrzsz")
    : state.tr("terminalTransfer.protocolTrzsz");
  const help = protocol === "lrzsz"
    ? state.tr("terminalTransfer.protocolLrzszHelp")
    : state.tr("terminalTransfer.protocolTrzszHelp");
  const checkedCount = Number(state.protocols.lrzsz) + Number(state.protocols.trzsz);
  const disabled = state.disabled || (checked && checkedCount <= 1);
  return `
    <label class="terminal-transfer-protocol-option">
      <input
        type="checkbox"
        data-terminal-transfer-protocol="${escapeAttr(protocol)}"
        ${checked ? "checked" : ""}
        ${disabled ? "disabled" : ""}
      />
      <span>
        <strong>${escapeHtml(label)}</strong>
        <small>${escapeHtml(help)}</small>
      </span>
    </label>
  `;
}
