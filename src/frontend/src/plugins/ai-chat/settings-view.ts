import { escapeAttr, escapeHtml } from "../../utils";
import { renderAIConfigDialog } from "./settings/config-dialog-view";
import { renderMcpSettingsPanel } from "./settings/mcp-panel-view";
import { renderAIProviderSettingsPanel } from "./settings/provider-panel-view";
import type { AIAccessSettingsRenderState, AIAccessSettingsViewState } from "./settings/types";

export type { AIAccessSettingsViewState, AIConfigDialogViewState } from "./settings/types";

export function renderAIAccessSettingsView(state: AIAccessSettingsRenderState): string {
  const disabledAttr = state.disabled ? "disabled" : "";
  const activeTab = state.activeTab === "mcp" ? "mcp" : "ai";
  return `
    <div class="plugin-tool ai-access-settings">
      <div class="settings-group-title">${escapeHtml(state.tr("section.aiAccess"))}</div>
      <p class="settings-help">${escapeHtml(state.tr("ai.accessHelp"))}</p>
      <div class="settings-tabs ai-config-tabs" role="tablist" aria-label="${escapeAttr(state.tr("section.aiAccess"))}">
        <button type="button" role="tab" aria-selected="${activeTab === "ai"}" data-ai-settings-tab="ai" ${disabledAttr}>
          <i data-lucide="bot"></i>
          <span>${escapeHtml(state.tr("tab.aiProvider"))}</span>
        </button>
        <button type="button" role="tab" aria-selected="${activeTab === "mcp"}" data-ai-settings-tab="mcp" ${disabledAttr}>
          <i data-lucide="workflow"></i>
          <span>${escapeHtml(state.tr("tab.mcp"))}</span>
        </button>
      </div>
      ${activeTab === "mcp" ? renderMcpSettingsPanel(state) : renderAIProviderSettingsPanel(state)}
      <div class="plugin-action-row ai-config-actions">
        <button class="command-button" type="button" data-ai-action="models" ${disabledAttr}>
          <i data-lucide="list-filter"></i>
          <span>${escapeHtml(state.tr("action.aiFetchModels"))}</span>
        </button>
        <button class="command-button" type="button" data-ai-action="test" ${disabledAttr}>
          <i data-lucide="activity"></i>
          <span>${escapeHtml(state.tr("action.aiTest"))}</span>
        </button>
      </div>
      ${state.dialog ? renderAIConfigDialog(state) : ""}
    </div>
  `;
}
