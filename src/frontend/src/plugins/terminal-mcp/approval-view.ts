import type { MessageKey } from "../../i18n.ts";
import { escapeAttr, escapeHtml } from "../../utils.ts";
import type { ControlGrant, ControlRequest } from "./types.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderTerminalMcpApprovalRequest(
  request: ControlRequest,
  busy: boolean,
  disabled: boolean,
  tr: Translate,
): string {
  return `
    <div class="ai-mcp-item terminal-mcp-control-item" role="listitem">
      <span class="ai-mcp-main">
        <strong>${escapeHtml(request.callerName)}</strong>
        <small>${escapeHtml(request.callerAppId)}</small>
        <small>${escapeHtml(request.target.label)} · ${escapeHtml(request.target.backend)} · ${escapeHtml(request.target.sessionId)}</small>
        <small>${escapeHtml(request.capability)}${request.reason ? ` · ${escapeHtml(request.reason)}` : ""}</small>
      </span>
      <span class="ai-mcp-transport">${escapeHtml(tr("terminalMcp.pending"))}</span>
      <span class="ai-mcp-actions">
        <button class="command-button danger" type="button" data-terminal-mcp-request-deny="${escapeAttr(request.id)}" ${busy || disabled ? "disabled" : ""}>
          ${escapeHtml(tr("terminalMcp.deny"))}
        </button>
        <button class="command-button primary" type="button" data-terminal-mcp-request-approve="${escapeAttr(request.id)}" ${busy || disabled ? "disabled" : ""}>
          ${escapeHtml(tr("terminalMcp.approve"))}
        </button>
      </span>
    </div>
  `;
}

export function renderTerminalMcpGrant(
  grant: ControlGrant,
  busy: boolean,
  disabled: boolean,
  tr: Translate,
): string {
  return `
    <div class="ai-mcp-item terminal-mcp-control-item" role="listitem">
      <span class="ai-mcp-main">
        <strong>${escapeHtml(grant.callerName)}</strong>
        <small>${escapeHtml(grant.callerAppId)}</small>
        <small>${escapeHtml(grant.target.label)} · ${escapeHtml(grant.target.backend)} · ${escapeHtml(grant.target.sessionId)}</small>
        <small>${escapeHtml(grant.capabilities.join(", "))}</small>
      </span>
      <span class="ai-mcp-transport">${escapeHtml(tr("terminalMcp.granted"))}</span>
      <span class="ai-mcp-actions">
        <button class="command-button danger" type="button" data-terminal-mcp-grant-revoke="${escapeAttr(grant.id)}" ${busy || disabled ? "disabled" : ""}>
          ${escapeHtml(tr("terminalMcp.revoke"))}
        </button>
      </span>
    </div>
  `;
}
