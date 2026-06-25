import type { AiMcpServerSettings } from "../../../types";
import { escapeAttr, escapeHtml } from "../../../utils";
import { mcpTransportLabel } from "./helpers";
import type { AIAccessSettingsRenderState } from "./types";

export function renderMcpSettingsPanel(state: AIAccessSettingsRenderState): string {
  return `
    <div class="ai-mcp-panel" role="tabpanel">
      <p class="settings-help">${escapeHtml(state.tr("ai.mcpHelp"))}</p>
      <div class="ai-mcp-list" role="list">
        ${state.mcpServers.length ? state.mcpServers.map((server, index) => renderMcpServerItem(server, index, state)).join("") : `<div class="empty">${escapeHtml(state.tr("ai.mcpEmpty"))}</div>`}
      </div>
      <button class="command-button" type="button" data-ai-config-open="mcp" data-ai-mcp-index="-1" ${state.disabled ? "disabled" : ""}>
        <i data-lucide="plus"></i>
        <span>${escapeHtml(state.tr("action.mcpAdd"))}</span>
      </button>
    </div>
  `;
}

function renderMcpServerItem(
  server: AiMcpServerSettings,
  index: number,
  state: AIAccessSettingsRenderState,
): string {
  const title = server.name || server.url;
  return `
    <div class="ai-mcp-item" role="listitem">
      <span class="ai-mcp-main">
        <strong>${escapeHtml(title)}</strong>
        <small>${escapeHtml(server.url)}</small>
      </span>
      <span class="ai-mcp-transport">${escapeHtml(mcpTransportLabel(server.transport, state.tr))}</span>
      <span class="ai-mcp-actions">
        <button class="icon-button" type="button" data-ai-config-open="mcp" data-ai-mcp-index="${escapeAttr(String(index))}" aria-label="${escapeAttr(state.tr("action.mcpEdit"))}" title="${escapeAttr(state.tr("action.mcpEdit"))}" ${state.disabled ? "disabled" : ""}>
          <i data-lucide="square-pen"></i>
        </button>
        <button class="icon-button" type="button" data-ai-mcp-remove="${escapeAttr(String(index))}" aria-label="${escapeAttr(state.tr("action.mcpRemove"))}" title="${escapeAttr(state.tr("action.mcpRemove"))}" ${state.disabled ? "disabled" : ""}>
          <i data-lucide="trash-2"></i>
        </button>
      </span>
    </div>
  `;
}
