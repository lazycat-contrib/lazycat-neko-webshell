import type {
  AiVoiceEndpointType,
  AiVoiceProviderKind,
  AiVoiceProviderProfile,
  AiVoiceSpeechEndpointType,
  AiVoiceSpeechProviderProfile,
} from "../../../types";
import { escapeAttr, escapeHtml } from "../../../utils";
import { aiVoiceProfileConfigured } from "../voice-profiles";
import { aiVoiceSpeechProfileConfigured } from "../voice-speech-profiles";
import type { AIAccessSettingsRenderState } from "./types";

export function renderVoiceSettingsPanel(state: AIAccessSettingsRenderState): string {
  const activeProfile = state.voiceProfiles.find((profile) => profile.id === state.activeVoiceProfileId);
  const activeReplyProfile = state.voiceReplyProfiles.find((profile) => profile.id === state.activeVoiceReplyProfileId);
  return `
    <div class="ai-voice-panel" role="tabpanel">
      ${renderVoiceInputSection(activeProfile, state)}
      ${renderVoiceReplySection(activeReplyProfile, state)}
    </div>
  `;
}

function renderVoiceInputSection(
  profile: AiVoiceProviderProfile | undefined,
  state: AIAccessSettingsRenderState,
): string {
  const configured = aiVoiceProfileConfigured(profile);
  return `
    <section class="ai-voice-summary-section">
      <div class="ai-voice-section-head">
        <label class="ai-voice-enable-row">
          <input type="checkbox" data-ai-voice-enabled ${state.voiceInputEnabled ? "checked" : ""} ${state.disabled ? "disabled" : ""} />
          <span>
            <strong>${escapeHtml(state.tr("setting.aiVoiceInputEnabled"))}</strong>
            <small>${escapeHtml(state.tr("ai.voiceEnableHelp"))}</small>
          </span>
        </label>
      </div>
      <div class="ai-config-summary-row">
        ${renderVoiceProfileSummary({
          title: profile?.name || state.tr("status.noTarget"),
          provider: profile ? voiceProviderLabel(profile.provider, state) : state.tr("ai.voiceNotConfigured"),
          model: profile?.model || state.tr("status.noTarget"),
          endpoint: profile ? voiceEndpointLabel(profile.endpointType, state) : state.tr("status.noTarget"),
          status: configured ? profile?.baseUrl ?? "" : state.tr("ai.voiceNotConfigured"),
        })}
        <span class="ai-config-summary-actions">
          ${renderProfileSelect({
            profiles: state.voiceProfiles,
            activeProfileId: state.activeVoiceProfileId,
            dataAttr: "data-ai-voice-profile-active",
            disabled: state.disabled,
            label: state.tr("action.aiVoiceProviderSelect"),
          })}
          <button class="icon-button" type="button" data-ai-config-open="voice" data-ai-voice-profile-id="${escapeAttr(profile?.id ?? "")}" aria-label="${escapeAttr(state.tr("action.aiVoiceProviderEdit"))}" title="${escapeAttr(state.tr("action.aiVoiceProviderEdit"))}" ${state.disabled || !profile ? "disabled" : ""}>
            <i data-lucide="settings-2"></i>
          </button>
          <button class="icon-button" type="button" data-ai-config-open="voice" data-ai-voice-new="true" aria-label="${escapeAttr(state.tr("action.aiVoiceProviderAdd"))}" title="${escapeAttr(state.tr("action.aiVoiceProviderAdd"))}" ${state.disabled ? "disabled" : ""}>
            <i data-lucide="plus"></i>
          </button>
        </span>
      </div>
    </section>
  `;
}

export function voiceProviderLabel(provider: AiVoiceProviderKind, state: AIAccessSettingsRenderState): string {
  if (provider === "mimo") return state.tr("ai.voiceProviderMimo");
  if (provider === "mimo-token-plan") return state.tr("ai.voiceProviderMimoTokenPlan");
  return state.tr("ai.voiceProviderCompatible");
}

export function voiceEndpointLabel(endpointType: AiVoiceEndpointType, state: AIAccessSettingsRenderState): string {
  return endpointType === "chat-input-audio"
    ? state.tr("ai.voiceEndpointChatInputAudio")
    : state.tr("ai.voiceEndpointAudioTranscriptions");
}

function renderVoiceReplySection(
  profile: AiVoiceSpeechProviderProfile | undefined,
  state: AIAccessSettingsRenderState,
): string {
  const configured = aiVoiceSpeechProfileConfigured(profile);
  return `
    <section class="ai-voice-summary-section">
      <div class="ai-voice-section-head">
        <label class="ai-voice-enable-row">
          <input type="checkbox" data-ai-voice-reply-enabled ${state.voiceReplyEnabled ? "checked" : ""} ${state.disabled ? "disabled" : ""} />
          <span>
            <strong>${escapeHtml(state.tr("setting.aiVoiceReplyEnabled"))}</strong>
            <small>${escapeHtml(state.tr("ai.voiceReplyEnableHelp"))}</small>
          </span>
        </label>
      </div>
      <div class="ai-config-summary-row">
        ${renderVoiceProfileSummary({
          title: profile?.name || state.tr("status.noTarget"),
          provider: profile ? voiceProviderLabel(profile.provider, state) : state.tr("ai.voiceReplyNotConfigured"),
          model: profile?.model || state.tr("status.noTarget"),
          endpoint: profile ? voiceSpeechEndpointLabel(profile.endpointType, state) : state.tr("status.noTarget"),
          status: configured ? [profile?.voice, profile?.format].filter(Boolean).join(" · ") : state.tr("ai.voiceReplyNotConfigured"),
        })}
        <span class="ai-config-summary-actions">
          ${renderProfileSelect({
            profiles: state.voiceReplyProfiles,
            activeProfileId: state.activeVoiceReplyProfileId,
            dataAttr: "data-ai-voice-reply-profile-active",
            disabled: state.disabled,
            label: state.tr("action.aiVoiceReplyProviderSelect"),
          })}
          <button class="icon-button" type="button" data-ai-voice-reply-test aria-label="${escapeAttr(state.tr("action.aiVoiceReplyTest"))}" title="${escapeAttr(state.tr("action.aiVoiceReplyTest"))}" ${state.disabled || state.voiceReplyTest.status === "loading" || !configured ? "disabled" : ""}>
            <i data-lucide="${state.voiceReplyTest.status === "loading" ? "loader-circle" : "volume-2"}"></i>
          </button>
          <button class="icon-button" type="button" data-ai-config-open="voice-reply" data-ai-voice-reply-profile-id="${escapeAttr(profile?.id ?? "")}" aria-label="${escapeAttr(state.tr("action.aiVoiceReplyProviderEdit"))}" title="${escapeAttr(state.tr("action.aiVoiceReplyProviderEdit"))}" ${state.disabled || !profile ? "disabled" : ""}>
            <i data-lucide="settings-2"></i>
          </button>
          <button class="icon-button" type="button" data-ai-config-open="voice-reply" data-ai-voice-reply-new="true" aria-label="${escapeAttr(state.tr("action.aiVoiceReplyProviderAdd"))}" title="${escapeAttr(state.tr("action.aiVoiceReplyProviderAdd"))}" ${state.disabled ? "disabled" : ""}>
            <i data-lucide="plus"></i>
          </button>
        </span>
      </div>
      ${renderVoiceReplyTest(state)}
    </section>
  `;
}

function renderVoiceReplyTest(state: AIAccessSettingsRenderState): string {
  const test = state.voiceReplyTest;
  if (test.status === "idle") return "";
  const status = test.status === "loading"
    ? state.tr("status.aiVoiceReplyTestLoading")
    : test.status === "ready"
      ? state.tr("status.aiVoiceReplyTestReady")
      : state.tr("status.aiVoiceReplyFailed", { message: test.error ?? "" });
  const details = test.status === "ready"
    ? [test.contentType, formatAudioSize(test.sizeBytes), formatAudioDuration(test.durationSeconds)].filter(Boolean).join(" · ")
    : "";
  return `
    <div class="ai-voice-test" data-state="${escapeAttr(test.status)}">
      <span class="ai-voice-test-status">${escapeHtml(status)}</span>
      ${details ? `<span class="ai-voice-test-meta">${escapeHtml(details)}</span>` : ""}
      ${test.objectUrl ? `<audio controls preload="metadata" src="${escapeAttr(test.objectUrl)}"></audio>` : ""}
    </div>
  `;
}

function renderVoiceProfileSummary(options: {
  title: string;
  provider: string;
  model: string;
  endpoint: string;
  status: string;
}): string {
  return `
    <span class="ai-config-summary-main">
      <strong>${escapeHtml(options.title)}</strong>
      <small>${escapeHtml(options.provider)}</small>
    </span>
    <span class="ai-config-summary-meta">
      <span>${escapeHtml(options.model)}</span>
      <span>${escapeHtml(options.endpoint)}</span>
      <span>${escapeHtml(options.status)}</span>
    </span>
  `;
}

function renderProfileSelect(options: {
  profiles: Array<AiVoiceProviderProfile | AiVoiceSpeechProviderProfile>;
  activeProfileId: string;
  dataAttr: string;
  disabled: boolean;
  label: string;
}): string {
  return `
    <label class="ai-voice-profile-select">
      <span class="sr-only">${escapeHtml(options.label)}</span>
      <select ${options.dataAttr} aria-label="${escapeAttr(options.label)}" ${options.disabled || !options.profiles.length ? "disabled" : ""}>
        ${options.profiles.map((profile) => `
          <option value="${escapeAttr(profile.id)}" ${profile.id === options.activeProfileId ? "selected" : ""}>
            ${escapeHtml(profile.name)}
          </option>
        `).join("")}
      </select>
    </label>
  `;
}

function voiceSpeechEndpointLabel(endpointType: AiVoiceSpeechEndpointType, state: AIAccessSettingsRenderState): string {
  return endpointType === "chat-audio"
    ? state.tr("ai.voiceEndpointChatAudio")
    : state.tr("ai.voiceEndpointAudioSpeech");
}

function formatAudioSize(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "";
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(value / 1024))} KB`;
}

function formatAudioDuration(value: number | undefined): string {
  if (!value || !Number.isFinite(value)) return "";
  const seconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}
