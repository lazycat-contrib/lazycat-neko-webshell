import { renderAIChatContextToggle } from "../../ai-chat/options-view";
import { renderChatMarkdown } from "../../chat-markdown";
import type { MessageKey } from "../../i18n";
import type { AIChatMessage, AIChatSession, AiProviderProfile } from "../../types";
import { escapeAttr, escapeHtml } from "../../utils";
import type { AiVoiceReplyPlaybackState } from "./voice-reply";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type SelectOption = {
  value: string;
  label: string;
};

export type AIChatViewState = {
  disabled: boolean;
  title: string;
  description: string;
  session: AIChatSession;
  messages: AIChatMessage[];
  streaming: boolean;
  modelOptions: SelectOption[];
  selectedModel: string;
  providerProfiles: AiProviderProfile[];
  activeProviderProfileId: string;
  providerPickerOpen: boolean;
  targetTerminalLabel: string;
  sendTerminalContext: boolean;
  terminalContextPreview: string;
  voiceReplyEnabled: boolean;
  voiceReplyStateForMessage: (messageIndex: number, content: string) => AiVoiceReplyPlaybackState;
  tr: Translate;
};

export function renderAIChatToolView(state: AIChatViewState): string {
  const disabledAttr = state.disabled ? "disabled" : "";
  const tr = state.tr;
  return `
    <div class="plugin-tool ai-chat-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(state.title)}</div>
          <p class="settings-help">${escapeHtml(state.description)}</p>
        </div>
        <div class="ai-chat-actions">
          ${renderAIChatContextToggle({
            enabled: state.sendTerminalContext,
            disabled: state.disabled || state.streaming,
            tr,
          })}
          <button class="icon-button" type="button" data-ai-action="new-chat" aria-label="${escapeAttr(tr("action.aiNewChat"))}" title="${escapeAttr(tr("action.aiNewChat"))}" ${disabledAttr}>
            <i data-lucide="message-square-plus"></i>
          </button>
          <button class="icon-button" type="button" data-ai-action="export-chat" aria-label="${escapeAttr(tr("action.aiExport"))}" title="${escapeAttr(tr("action.aiExport"))}" ${disabledAttr}>
            <i data-lucide="download"></i>
          </button>
          <button class="icon-button" type="button" data-ai-action="models" aria-label="${escapeAttr(tr("action.aiFetchModels"))}" title="${escapeAttr(tr("action.aiFetchModels"))}" ${disabledAttr}>
            <i data-lucide="list-filter"></i>
          </button>
          <button class="icon-button" type="button" data-ai-action="test" aria-label="${escapeAttr(tr("action.aiTest"))}" title="${escapeAttr(tr("action.aiTest"))}" ${disabledAttr}>
            <i data-lucide="activity"></i>
          </button>
        </div>
      </div>
      <div class="ai-chat-box">
        <div class="ai-chat-history" id="aiChatHistory" aria-live="polite">
          ${renderAIChatMessages(state)}
        </div>
        <div class="ai-chat-composer">
          <div class="ai-chat-model-row">
            ${renderAITargetTerminal(state)}
            ${renderAIProviderPicker(state)}
            ${renderAIChatPicker({
              field: "model",
              label: tr("field.aiModel"),
              options: state.modelOptions,
              selected: state.selectedModel,
              disabled: state.disabled,
            })}
            <button class="icon-button" type="button" data-ai-action="copy-output" aria-label="${escapeAttr(tr("action.aiCopy"))}" title="${escapeAttr(tr("action.aiCopy"))}" ${disabledAttr}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button" type="button" data-ai-action="clear-output" aria-label="${escapeAttr(tr("action.aiClear"))}" title="${escapeAttr(tr("action.aiClear"))}" ${disabledAttr}>
              <i data-lucide="x"></i>
            </button>
          </div>
          <div class="ai-chat-input-row">
            <textarea id="aiChatInput" rows="1" spellcheck="false" placeholder="${escapeAttr(tr("field.aiPrompt"))}" ${disabledAttr}></textarea>
            <button class="command-button primary" type="button" data-ai-action="send-chat" ${disabledAttr}>
              <i data-lucide="send"></i>
              <span>${escapeHtml(tr("action.aiSend"))}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  `;
}

export function renderAIChatMessages(
  state: Pick<AIChatViewState, "messages" | "streaming" | "sendTerminalContext" | "terminalContextPreview" | "voiceReplyEnabled" | "voiceReplyStateForMessage" | "tr">,
): string {
  if (!state.messages.length) {
    return `<div class="empty">${escapeHtml(state.tr("plugin.aiChat.description"))}</div>`;
  }
  return state.messages.map((message, index) => {
    const thinking = message.role === "assistant" && !message.content.trim() && state.streaming;
    const markdown = !thinking && message.role !== "user";
    const content = thinking
      ? `<div class="ai-thinking" role="status" aria-label="${escapeAttr(state.tr("status.aiWorking"))}"><span class="ai-thinking-leds" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>`
      : markdown ? renderChatMarkdown(message.content, {
        copyLabel: state.tr("action.aiCopy"),
        sendLabel: state.tr("action.aiSendToTerminal"),
      }) : escapeHtml(message.content);
    const contentClass = [
      "ai-chat-message-content",
      thinking ? "is-thinking" : "",
      markdown ? "ai-chat-markdown" : "",
    ].filter(Boolean).join(" ");
    const contentBlock = `<div class="${escapeAttr(contentClass)}">${content}</div>`;
    const voiceReply = message.role === "assistant"
      && state.voiceReplyEnabled
      && message.tone !== "error"
      && !thinking
      && message.content.trim();
    const body = voiceReply
      ? renderAIVoiceReplyMessage({
        state: state.voiceReplyStateForMessage(index, message.content),
        messageIndex: index,
        textContent: contentBlock,
        tr: state.tr,
      })
      : contentBlock;
    return `
    <article class="ai-chat-message ${escapeAttr(message.role)}" data-tone="${escapeAttr(message.tone ?? "neutral")}">
      <div class="ai-chat-message-head">
        <span class="ai-chat-avatar" aria-hidden="true"><i data-lucide="${escapeAttr(aiChatRoleIcon(message.role))}"></i></span>
        <span class="ai-chat-message-role">${escapeHtml(aiChatRoleLabel(message.role))}</span>
        ${message.role === "assistant" ? renderAIContextLcd(state) : ""}
        ${message.content.trim() ? `<button class="ai-message-copy" type="button" data-ai-action="copy-message" data-ai-message-index="${escapeAttr(String(index))}" aria-label="${escapeAttr(state.tr("action.aiCopy"))}" title="${escapeAttr(state.tr("action.aiCopy"))}"><i data-lucide="copy"></i></button>` : ""}
      </div>
      ${body}
    </article>
  `;
  }).join("");
}

function renderAIVoiceReplyMessage(options: {
  state: AiVoiceReplyPlaybackState;
  messageIndex: number;
  textContent: string;
  tr: Translate;
}): string {
  const progress = voiceReplyProgress(options.state);
  const playing = options.state.status === "playing";
  const loading = options.state.status === "loading";
  const actionLabel = playing ? options.tr("action.aiVoiceReplyPause") : options.tr("action.aiVoiceReplyPlay");
  return `
    <div class="ai-voice-reply">
      <div class="ai-voice-reply-player" data-state="${escapeAttr(options.state.status)}">
        <button class="ai-voice-reply-toggle" type="button" data-ai-action="toggle-voice-reply" data-ai-message-index="${escapeAttr(String(options.messageIndex))}" aria-label="${escapeAttr(actionLabel)}" title="${escapeAttr(actionLabel)}" ${loading ? "disabled" : ""}>
          <i data-lucide="${playing ? "pause" : loading ? "loader-circle" : "play"}"></i>
        </button>
        <div class="ai-voice-reply-track" aria-label="${escapeAttr(voiceReplyStatusLabel(options.state, options.tr))}">
          <span style="width: ${escapeAttr(String(progress))}%"></span>
        </div>
        <span class="ai-voice-reply-time">${escapeHtml(voiceReplyTimeLabel(options.state))}</span>
      </div>
      ${options.state.status === "error" && options.state.error ? `<p class="ai-voice-reply-error">${escapeHtml(options.state.error)}</p>` : ""}
      <details class="ai-voice-reply-text">
        <summary>
          <i data-lucide="message-square-text"></i>
          <span>${escapeHtml(options.tr("action.aiVoiceReplyShowText"))}</span>
        </summary>
        ${options.textContent}
      </details>
    </div>
  `;
}

function voiceReplyProgress(state: AiVoiceReplyPlaybackState): number {
  if (state.status === "loading") return 35;
  const duration = state.durationSeconds ?? 0;
  if (duration <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round(((state.currentSeconds ?? 0) / duration) * 100)));
}

function voiceReplyStatusLabel(state: AiVoiceReplyPlaybackState, tr: Translate): string {
  if (state.status === "loading") return tr("status.aiVoiceReplyLoading");
  if (state.status === "playing") return tr("status.aiVoiceReplyPlaying");
  if (state.status === "error") return tr("status.aiVoiceReplyFailed", { message: state.error ?? "" });
  return tr("status.aiVoiceReplyReady");
}

function voiceReplyTimeLabel(state: AiVoiceReplyPlaybackState): string {
  const duration = formatVoiceReplySeconds(state.durationSeconds);
  if (state.status === "playing" || (state.currentSeconds ?? 0) > 0) {
    return `${formatVoiceReplySeconds(state.currentSeconds)} / ${duration}`;
  }
  return duration;
}

function formatVoiceReplySeconds(value: number | undefined): string {
  if (!Number.isFinite(value) || !value || value < 0) return "--:--";
  const totalSeconds = Math.max(0, Math.round(value));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function aiChatTranscript(session: AIChatSession): string {
  return session.messages
    .map((message) => `## ${aiChatRoleLabel(message.role)}\n\n${message.content}`)
    .join("\n\n");
}

function renderAITargetTerminal(state: AIChatViewState): string {
  const label = state.targetTerminalLabel.trim() || state.tr("status.noTarget");
  return `
    <div class="ai-context-lcd ai-target-lcd" title="${escapeAttr(label)}" aria-label="${escapeAttr(state.tr("field.aiTargetTerminal"))}">
      <i data-lucide="terminal"></i>
      <span>${escapeHtml(label)}</span>
    </div>
  `;
}

function renderAIProviderPicker(state: AIChatViewState): string {
  const activeProfile = activeAiProviderProfile(state.providerProfiles, state.activeProviderProfileId);
  const label = activeProfile?.name || state.tr("status.noTarget");
  const disabledAttr = state.disabled || !state.providerProfiles.length ? "disabled" : "";
  return `
    <div class="ai-provider-picker-shell">
      <button class="ai-provider-button" type="button" data-ai-action="toggle-provider-menu" aria-haspopup="menu" aria-expanded="${state.providerPickerOpen}" title="${escapeAttr(state.tr("action.aiProviderSelect"))}" ${disabledAttr}>
        <i data-lucide="bot"></i>
        <span>${escapeHtml(label)}</span>
      </button>
      ${state.providerPickerOpen ? `
        <div class="ai-provider-menu" role="menu">
          ${state.providerProfiles.length ? state.providerProfiles.map((profile) => `
            <button type="button" role="menuitemradio" aria-checked="${profile.id === state.activeProviderProfileId}" data-ai-profile-select="${escapeAttr(profile.id)}">
              <span>
                <strong>${escapeHtml(profile.name)}</strong>
                <small>${escapeHtml([aiProviderLabel(profile.provider, state.tr), profile.model || state.tr("status.noTarget")].join(" · "))}</small>
              </span>
              ${profile.id === state.activeProviderProfileId ? `<i data-lucide="check"></i>` : ""}
            </button>
          `).join("") : `<div class="empty">${escapeHtml(state.tr("status.noTarget"))}</div>`}
        </div>
      ` : ""}
    </div>
  `;
}

function renderAIContextLcd(state: Pick<AIChatViewState, "sendTerminalContext" | "terminalContextPreview" | "tr">): string {
  if (!state.sendTerminalContext || !state.terminalContextPreview.trim()) return "";
  const lines = state.terminalContextPreview.trim().split(/\r?\n/).slice(-12);
  return `
    <div class="ai-context-lcd" role="note" aria-label="${escapeAttr(state.tr("setting.aiTerminalContext"))}">
      <pre>${escapeHtml(lines.join("\n"))}</pre>
    </div>
  `;
}

function renderAIChatPicker(options: {
  field: string;
  label: string;
  options: SelectOption[];
  selected: string;
  disabled: boolean;
}): string {
  const items = options.options.map((option) => `
    <option value="${escapeAttr(option.value)}" ${option.value === options.selected ? "selected" : ""} ${option.value ? "" : "disabled"}>
      ${escapeHtml(option.label)}
    </option>
  `).join("");
  return `
    <label class="ai-chat-picker" title="${escapeAttr(options.label)}">
      <span class="ai-chat-picker-label">${escapeHtml(options.label)}</span>
      <span class="ai-chat-select-shell">
        <select data-ai-chat-setting="${escapeAttr(options.field)}" aria-label="${escapeAttr(options.label)}" ${options.disabled ? "disabled" : ""}>
          ${items}
        </select>
        <i data-lucide="chevron-down"></i>
      </span>
    </label>
  `;
}

function aiChatRoleLabel(role: AIChatMessage["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "AI";
  return "WebShell";
}

function aiChatRoleIcon(role: AIChatMessage["role"]): string {
  if (role === "user") return "user";
  if (role === "assistant") return "bot";
  return "terminal";
}

function aiProviderLabel(provider: string, tr: Translate): string {
  if (provider === "openai-responses") return tr("ai.providerOpenAIResponses");
  if (provider === "anthropic") return tr("ai.providerAnthropic");
  return tr("ai.providerOpenAICompatible");
}

function activeAiProviderProfile(profiles: AiProviderProfile[], activeProfileId: string): AiProviderProfile | undefined {
  return profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
}
