import { escapeAttr, escapeHtml } from "../../../utils";
import { activeAiProviderProfile, aiProviderLabel } from "./helpers";
import type { AIAccessSettingsRenderState } from "./types";

export function renderAIProviderSettingsPanel(state: AIAccessSettingsRenderState): string {
  const maskedKey = state.apiKey ? "••••••••" : state.tr("status.noTarget");
  const provider = aiProviderLabel(state.provider, state.tr);
  const activeProfile = activeAiProviderProfile(state.profiles, state.activeProfileId);
  const profileName = activeProfile?.name || state.tr("status.noTarget");
  return `
    <div class="ai-config-summary" role="tabpanel">
      <div class="ai-config-summary-row">
        <span class="ai-config-summary-main">
          <strong>${escapeHtml(profileName)}</strong>
          <small>${escapeHtml(provider)}</small>
        </span>
        <span class="ai-config-summary-meta">
          <span>${escapeHtml(state.model || state.tr("status.noTarget"))}</span>
          <span>${escapeHtml(state.baseUrl || state.tr("status.noTarget"))}</span>
          <span>${escapeHtml(maskedKey)}</span>
        </span>
        <span class="ai-config-summary-actions">
          <button class="command-button" type="button" data-ai-config-open="ai" data-ai-profile-id="${escapeAttr(activeProfile?.id ?? "")}" ${state.disabled || !activeProfile ? "disabled" : ""}>
            <i data-lucide="settings-2"></i>
            <span>${escapeHtml(state.tr("action.aiProviderEdit"))}</span>
          </button>
          <button class="command-button" type="button" data-ai-config-open="ai" data-ai-profile-new="true" ${state.disabled ? "disabled" : ""}>
            <i data-lucide="plus"></i>
            <span>${escapeHtml(state.tr("action.aiProviderAdd"))}</span>
          </button>
        </span>
      </div>
    </div>
  `;
}
