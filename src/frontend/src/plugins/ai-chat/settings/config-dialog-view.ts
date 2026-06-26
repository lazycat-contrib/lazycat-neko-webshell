import { escapeAttr, escapeHtml } from "../../../utils";
import { AI_VOICE_INPUT_FORMATS, aiVoiceInputFormatLabel, isBuiltinAiVoiceProfile } from "../voice-profiles";
import {
  isBuiltinAiVoiceSpeechProfile,
  SPEECH_FORMATS,
  speechVoicePresets,
} from "../voice-speech-profiles";
import { activeAiProviderProfile, emptyAiProviderProfile } from "./helpers";
import type { AIAccessSettingsRenderState, AIConfigDialogViewState } from "./types";

export function renderAIConfigDialog(state: AIAccessSettingsRenderState): string {
  const dialog = state.dialog;
  if (!dialog) return "";
  const title = dialog.type === "mcp"
    ? dialog.index >= 0 ? state.tr("action.mcpEdit") : state.tr("action.mcpAdd")
    : dialog.type === "voice"
      ? dialog.isNew ? state.tr("action.aiVoiceProviderAdd") : state.tr("action.aiVoiceProviderEdit")
      : dialog.type === "voice-reply"
        ? dialog.isNew ? state.tr("action.aiVoiceReplyProviderAdd") : state.tr("action.aiVoiceReplyProviderEdit")
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
          ${dialog.type === "mcp"
            ? renderMcpConfigForm(dialog, state)
            : dialog.type === "voice"
              ? renderVoiceConfigForm(dialog, state)
              : dialog.type === "voice-reply"
                ? renderVoiceReplyConfigForm(dialog, state)
                : renderAIProviderConfigForm(state)}
        </div>
        <footer class="ai-config-modal-actions">
          ${dialog.type === "ai" && !dialog.isNew && state.profiles.length > 1 ? `
            <button class="command-button danger" type="button" data-ai-profile-remove="${escapeAttr(dialog.profile.id)}">
              <i data-lucide="trash-2"></i>
              <span>${escapeHtml(state.tr("action.aiProviderRemove"))}</span>
            </button>
          ` : ""}
          ${dialog.type === "voice" && !dialog.isNew && !isBuiltinAiVoiceProfile(dialog.profile.id) && state.voiceProfiles.length > 2 ? `
            <button class="command-button danger" type="button" data-ai-voice-profile-remove="${escapeAttr(dialog.profile.id)}">
              <i data-lucide="trash-2"></i>
              <span>${escapeHtml(state.tr("action.aiVoiceProviderRemove"))}</span>
            </button>
          ` : ""}
          ${dialog.type === "voice-reply" && !dialog.isNew && !isBuiltinAiVoiceSpeechProfile(dialog.profile.id) && state.voiceReplyProfiles.length > 3 ? `
            <button class="command-button danger" type="button" data-ai-voice-reply-profile-remove="${escapeAttr(dialog.profile.id)}">
              <i data-lucide="trash-2"></i>
              <span>${escapeHtml(state.tr("action.aiVoiceReplyProviderRemove"))}</span>
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

function renderVoiceConfigForm(
  dialog: Extract<AIConfigDialogViewState, { type: "voice" }>,
  state: AIAccessSettingsRenderState,
): string {
  const profile = dialog.profile;
  const fixedPreset = profile.provider === "mimo" || profile.provider === "mimo-token-plan";
  const formatOptions = AI_VOICE_INPUT_FORMATS
    .map((format) => `<option value="${escapeAttr(format)}" ${profile.format === format ? "selected" : ""}>${escapeHtml(aiVoiceInputFormatLabel(format))}</option>`)
    .join("");
  return `
    <div class="ai-config-grid">
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceProfileName"))}</span>
        <input data-ai-dialog-field="voiceName" type="text" value="${escapeAttr(profile.name)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceProvider"))}</span>
        <select data-ai-dialog-field="voiceProvider">
          <option value="mimo" ${profile.provider === "mimo" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceProviderMimo"))}</option>
          <option value="mimo-token-plan" ${profile.provider === "mimo-token-plan" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceProviderMimoTokenPlan"))}</option>
          <option value="openai-compatible" ${profile.provider === "openai-compatible" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceProviderCompatible"))}</option>
        </select>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceEndpointType"))}</span>
        <select data-ai-dialog-field="voiceEndpointType" ${fixedPreset ? "disabled" : ""}>
          <option value="audio-transcriptions" ${profile.endpointType === "audio-transcriptions" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceEndpointAudioTranscriptions"))}</option>
          <option value="chat-input-audio" ${profile.endpointType === "chat-input-audio" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceEndpointChatInputAudio"))}</option>
        </select>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceLanguage"))}</span>
        <input data-ai-dialog-field="voiceLanguage" type="text" value="${escapeAttr(profile.language)}" autocomplete="off" spellcheck="false" placeholder="auto / zh / en" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceFormat"))}</span>
        <select data-ai-dialog-field="voiceFormat" ${fixedPreset ? "disabled" : ""}>
          ${formatOptions}
        </select>
      </label>
      <label class="field ai-config-full">
        <span>${escapeHtml(state.tr("field.aiBaseUrl"))}</span>
        <input data-ai-dialog-field="voiceBaseUrl" type="url" value="${escapeAttr(profile.baseUrl)}" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiApiKey"))}</span>
        <input data-ai-dialog-field="voiceApiKey" type="password" value="${escapeAttr(profile.apiKey)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiModel"))}</span>
        <input data-ai-dialog-field="voiceModel" type="text" value="${escapeAttr(profile.model)}" autocomplete="off" spellcheck="false" />
      </label>
    </div>
    <p class="settings-help">${escapeHtml(state.tr("ai.voiceProviderHelp"))}</p>
  `;
}

function renderVoiceReplyConfigForm(
  dialog: Extract<AIConfigDialogViewState, { type: "voice-reply" }>,
  state: AIAccessSettingsRenderState,
): string {
  const profile = dialog.profile;
  const fixedPreset = profile.provider === "mimo" || profile.provider === "mimo-token-plan";
  const voices = speechVoicePresets(profile);
  const voiceOptions = voices
    .map((voice) => `<option value="${escapeAttr(voice.value)}">${escapeHtml(voice.label)}${voice.meta ? ` · ${escapeHtml(voice.meta)}` : ""}</option>`)
    .join("");
  const formatOptions = SPEECH_FORMATS
    .map((format) => `<option value="${escapeAttr(format)}" ${profile.format === format ? "selected" : ""}>${escapeHtml(format)}</option>`)
    .join("");
  return `
    <div class="ai-config-grid">
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceReplyProfileName"))}</span>
        <input data-ai-dialog-field="voiceReplyName" type="text" value="${escapeAttr(profile.name)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceProvider"))}</span>
        <select data-ai-dialog-field="voiceReplyProvider">
          <option value="mimo" ${profile.provider === "mimo" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceProviderMimo"))}</option>
          <option value="mimo-token-plan" ${profile.provider === "mimo-token-plan" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceProviderMimoTokenPlan"))}</option>
          <option value="openai-compatible" ${profile.provider === "openai-compatible" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceProviderCompatible"))}</option>
        </select>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceEndpointType"))}</span>
        <select data-ai-dialog-field="voiceReplyEndpointType" ${fixedPreset ? "disabled" : ""}>
          <option value="audio-speech" ${profile.endpointType === "audio-speech" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceEndpointAudioSpeech"))}</option>
          <option value="chat-audio" ${profile.endpointType === "chat-audio" ? "selected" : ""}>${escapeHtml(state.tr("ai.voiceEndpointChatAudio"))}</option>
        </select>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceReplyFormat"))}</span>
        <select data-ai-dialog-field="voiceReplyFormat">
          ${formatOptions}
        </select>
      </label>
      <label class="field ai-config-full">
        <span>${escapeHtml(state.tr("field.aiBaseUrl"))}</span>
        <input data-ai-dialog-field="voiceReplyBaseUrl" type="url" value="${escapeAttr(profile.baseUrl)}" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiApiKey"))}</span>
        <input data-ai-dialog-field="voiceReplyApiKey" type="password" value="${escapeAttr(profile.apiKey)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiModel"))}</span>
        <input data-ai-dialog-field="voiceReplyModel" type="text" value="${escapeAttr(profile.model)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiVoiceReplyVoice"))}</span>
        <input data-ai-dialog-field="voiceReplyVoice" type="text" list="aiVoiceReplyVoiceOptions" value="${escapeAttr(profile.voice)}" autocomplete="off" spellcheck="false" />
        <datalist id="aiVoiceReplyVoiceOptions">${voiceOptions}</datalist>
      </label>
      <label class="field ai-config-full">
        <span>${escapeHtml(state.tr("field.aiVoiceReplyInstructions"))}</span>
        <textarea data-ai-dialog-field="voiceReplyInstructions" rows="3" spellcheck="false" placeholder="${escapeAttr(state.tr("ai.voiceReplyInstructionsPlaceholder"))}">${escapeHtml(profile.instructions)}</textarea>
      </label>
    </div>
    <p class="settings-help">${escapeHtml(state.tr("ai.voiceReplyProviderHelp"))}</p>
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
