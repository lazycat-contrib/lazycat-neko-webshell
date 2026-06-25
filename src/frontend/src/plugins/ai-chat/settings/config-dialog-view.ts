import { escapeAttr, escapeHtml } from "../../../utils";
import { activeAiProviderProfile, emptyAiProviderProfile } from "./helpers";
import type { AIAccessSettingsRenderState, AIConfigDialogViewState } from "./types";

export function renderAIConfigDialog(state: AIAccessSettingsRenderState): string {
  const dialog = state.dialog;
  if (!dialog) return "";
  const title = dialog.type === "mcp"
    ? dialog.index >= 0 ? state.tr("action.mcpEdit") : state.tr("action.mcpAdd")
    : dialog.isNew ? state.tr("action.aiProviderAdd") : state.tr("action.aiProviderEdit");
  return `
    <div class="ai-config-modal-backdrop" data-ai-config-close>
      <section class="ai-config-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}" data-ai-config-modal>
        <header class="ai-config-modal-head">
          <strong>${escapeHtml(title)}</strong>
          <button class="icon-button" type="button" data-ai-config-close aria-label="${escapeAttr(state.tr("action.close"))}" title="${escapeAttr(state.tr("action.close"))}">
            <i data-lucide="x"></i>
          </button>
        </header>
        <div class="ai-config-modal-body">
          ${dialog.type === "mcp" ? renderMcpConfigForm(dialog, state) : renderAIProviderConfigForm(state)}
        </div>
        <footer class="ai-config-modal-actions">
          ${dialog.type === "ai" && !dialog.isNew && state.profiles.length > 1 ? `
            <button class="command-button danger" type="button" data-ai-profile-remove="${escapeAttr(dialog.profile.id)}">
              <i data-lucide="trash-2"></i>
              <span>${escapeHtml(state.tr("action.aiProviderRemove"))}</span>
            </button>
          ` : ""}
          <button class="command-button" type="button" data-ai-config-close>
            <span>${escapeHtml(state.tr("action.cancel"))}</span>
          </button>
          <button class="command-button primary" type="button" data-ai-config-save="${escapeAttr(dialog.type)}">
            <i data-lucide="save"></i>
            <span>${escapeHtml(state.tr("action.save"))}</span>
          </button>
        </footer>
      </section>
    </div>
  `;
}

function renderAIProviderConfigForm(state: AIAccessSettingsRenderState): string {
  const dialog = state.dialog?.type === "ai" ? state.dialog : undefined;
  const profile = dialog?.profile ?? activeAiProviderProfile(state.profiles, state.activeProfileId) ?? emptyAiProviderProfile();
  const modelValues = state.modelOptions.includes(profile.model) || !profile.model
    ? state.modelOptions
    : [profile.model, ...state.modelOptions];
  const modelOptions = modelValues
    .map((model) => `<option value="${escapeAttr(model)}">${escapeHtml(model)}</option>`)
    .join("");
  return `
    <div class="ai-config-grid">
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiProfileName"))}</span>
        <input data-ai-dialog-field="profileName" type="text" value="${escapeAttr(profile.name)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiProvider"))}</span>
        <select data-ai-dialog-field="provider">
          <option value="openai-compatible" ${profile.provider === "openai-compatible" ? "selected" : ""}>${escapeHtml(state.tr("ai.providerOpenAICompatible"))}</option>
          <option value="openai-responses" ${profile.provider === "openai-responses" ? "selected" : ""}>${escapeHtml(state.tr("ai.providerOpenAIResponses"))}</option>
          <option value="anthropic" ${profile.provider === "anthropic" ? "selected" : ""}>${escapeHtml(state.tr("ai.providerAnthropic"))}</option>
        </select>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiBaseUrl"))}</span>
        <input data-ai-dialog-field="baseUrl" type="url" value="${escapeAttr(profile.baseUrl)}" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiApiKey"))}</span>
        <input data-ai-dialog-field="apiKey" type="password" value="${escapeAttr(profile.apiKey)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiModel"))}</span>
        <input data-ai-dialog-field="model" type="text" list="aiModelOptions" value="${escapeAttr(profile.model)}" autocomplete="off" spellcheck="false" />
        <datalist id="aiModelOptions">${modelOptions}</datalist>
      </label>
    </div>
  `;
}

function renderMcpConfigForm(
  dialog: Extract<AIConfigDialogViewState, { type: "mcp" }>,
  state: AIAccessSettingsRenderState,
): string {
  return `
    <div class="ai-config-grid">
      <label class="field">
        <span>${escapeHtml(state.tr("field.mcpName"))}</span>
        <input data-ai-dialog-field="mcpName" type="text" value="${escapeAttr(dialog.server.name)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.mcpTransport"))}</span>
        <select data-ai-dialog-field="mcpTransport">
          <option value="streamable-http" ${dialog.server.transport === "streamable-http" ? "selected" : ""}>${escapeHtml(state.tr("mcp.transportHttp"))}</option>
          <option value="sse" ${dialog.server.transport === "sse" ? "selected" : ""}>${escapeHtml(state.tr("mcp.transportSse"))}</option>
        </select>
      </label>
      <label class="field ai-config-full">
        <span>${escapeHtml(state.tr("field.mcpUrl"))}</span>
        <input data-ai-dialog-field="mcpUrl" type="url" value="${escapeAttr(dialog.server.url)}" autocomplete="off" spellcheck="false" placeholder="https://example.com/mcp" />
      </label>
      <label class="field ai-config-full">
        <span>${escapeHtml(state.tr("field.mcpAuthorization"))}</span>
        <input data-ai-dialog-field="mcpAuthorization" type="password" value="${escapeAttr(dialog.server.authorization)}" autocomplete="off" spellcheck="false" placeholder="Bearer ..." />
      </label>
      <label class="field ai-config-full">
        <span>${escapeHtml(state.tr("field.mcpHeaders"))}</span>
        <textarea data-ai-dialog-field="mcpHeaders" rows="4" spellcheck="false" placeholder="X-Header: value">${escapeHtml(dialog.headersText)}</textarea>
      </label>
    </div>
    <p class="settings-help">${escapeHtml(state.tr("ai.mcpHeadersHelp"))}</p>
  `;
}
