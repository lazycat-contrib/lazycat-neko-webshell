import type { MessageKey } from "../../i18n.ts";
import { escapeAttr, escapeHtml } from "../../utils.ts";
import { renderTerminalMcpApprovalRequest, renderTerminalMcpGrant } from "./approval-view.ts";
import type { ControlGrant, ControlRequest, TerminalMcpPolicy } from "./types.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type TerminalMcpSettingsViewState = {
  enabled: boolean;
  disabled: boolean;
  policy: TerminalMcpPolicy;
  pendingRequests: ControlRequest[];
  activeGrants: ControlGrant[];
  busyIds: Set<string>;
  loading: boolean;
  error: string;
  tr: Translate;
};

export function renderTerminalMcpSettingsView(state: TerminalMcpSettingsViewState): string {
  const actionDisabled = state.disabled || !state.enabled;
  return `
    <div class="plugin-tool terminal-mcp-settings">
      <div class="settings-group-title">${escapeHtml(state.tr("terminalMcp.policyTitle"))}</div>
      <p class="settings-help">${escapeHtml(state.tr("terminalMcp.policyHelp"))}</p>
      <label class="field">
        <span>${escapeHtml(state.tr("terminalMcp.defaultPolicy"))}</span>
        <select data-terminal-mcp-policy-mode ${state.disabled ? "disabled" : ""}>
          ${policyOption("confirm", state)}
          ${policyOption("trusted_callers", state)}
          ${policyOption("same_user_automatic", state)}
          ${policyOption("read_only", state)}
        </select>
      </label>
      ${renderAutomaticWarning(state)}
      <label class="field">
        <span>${escapeHtml(state.tr("terminalMcp.trustedCallers"))}</span>
        <textarea data-terminal-mcp-trusted-callers spellcheck="false" ${state.disabled ? "disabled" : ""}>${escapeHtml(state.policy.trustedCallers.join("\n"))}</textarea>
      </label>
      <p class="settings-help">${escapeHtml(state.tr("terminalMcp.trustedCallersHelp"))}</p>
      <label class="field">
        <span>${escapeHtml(state.tr("terminalMcp.deniedCallers"))}</span>
        <textarea data-terminal-mcp-denied-callers spellcheck="false" ${state.disabled ? "disabled" : ""}>${escapeHtml(state.policy.deniedCallers.join("\n"))}</textarea>
      </label>
      <p class="settings-help">${escapeHtml(state.tr("terminalMcp.deniedCallersHelp"))}</p>
      <div class="font-actions">
        <button class="command-button" type="button" data-terminal-mcp-refresh ${actionDisabled || state.loading ? "disabled" : ""}>
          <i data-lucide="refresh-cw"></i>
          <span>${escapeHtml(state.tr("action.refresh"))}</span>
        </button>
        <button class="command-button primary" type="button" data-terminal-mcp-policy-save ${state.disabled ? "disabled" : ""}>
          <i data-lucide="save"></i>
          <span>${escapeHtml(state.tr("action.save"))}</span>
        </button>
      </div>
      <p class="settings-help">${escapeHtml(state.tr("terminalMcp.resourceDiscovery"))}</p>
      ${!state.enabled ? `<p class="field-status">${escapeHtml(state.tr("terminalMcp.disabledHelp"))}</p>` : ""}
      ${state.error ? `<p class="field-status" data-tone="error">${escapeHtml(state.error)}</p>` : ""}

      <div class="settings-group">
        <div class="settings-group-title">${escapeHtml(state.tr("terminalMcp.pendingTitle"))}</div>
        <p class="settings-help">${escapeHtml(state.tr("terminalMcp.pendingHelp"))}</p>
        <div class="ai-mcp-list" role="list">
          ${state.pendingRequests.length
            ? state.pendingRequests.map((request) => renderTerminalMcpApprovalRequest(
              request,
              state.busyIds.has(request.id),
              actionDisabled,
              state.tr,
            )).join("")
            : `<div class="empty">${escapeHtml(state.loading ? state.tr("terminalMcp.loading") : state.tr("terminalMcp.noPending"))}</div>`}
        </div>
      </div>

      <div class="settings-group">
        <div class="settings-group-title">${escapeHtml(state.tr("terminalMcp.grantsTitle"))}</div>
        <p class="settings-help">${escapeHtml(state.tr("terminalMcp.grantsHelp"))}</p>
        <div class="ai-mcp-list" role="list">
          ${state.activeGrants.length
            ? state.activeGrants.map((grant) => renderTerminalMcpGrant(
              grant,
              state.busyIds.has(grant.id),
              actionDisabled,
              state.tr,
            )).join("")
            : `<div class="empty">${escapeHtml(state.loading ? state.tr("terminalMcp.loading") : state.tr("terminalMcp.noGrants"))}</div>`}
        </div>
      </div>
    </div>
  `;
}

function policyOption(value: TerminalMcpPolicy["mode"], state: TerminalMcpSettingsViewState): string {
  const label = value === "confirm"
    ? state.tr("terminalMcp.policyConfirm")
    : value === "trusted_callers"
      ? state.tr("terminalMcp.policyTrusted")
      : value === "same_user_automatic"
        ? state.tr("terminalMcp.policyAutomatic")
        : state.tr("terminalMcp.policyReadOnly");
  return `<option value="${escapeAttr(value)}" ${state.policy.mode === value ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function renderAutomaticWarning(state: TerminalMcpSettingsViewState): string {
  if (state.policy.mode !== "same_user_automatic" && state.policy.mode !== "trusted_callers") {
    return "";
  }
  return `<p class="field-status" data-tone="error">${escapeHtml(state.tr("terminalMcp.automaticWarning"))}</p>`;
}
