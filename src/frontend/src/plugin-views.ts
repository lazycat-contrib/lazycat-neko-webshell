import type { MessageKey } from "./i18n";
import type { PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import {
  AI_CHAT_PLUGIN_ID,
  pluginDescription,
  pluginDisplayName,
  pluginIcon,
  pluginMetaLabel,
} from "./plugin-utils";
import { fileEntryIcon, formatFileSize, normalizeRemotePath } from "./remote-files";
import type { AIChatMessage, AIChatSession, AiMcpServerSettings, FileBrowserContextMenu, FileBrowserEntry } from "./types";
import { escapeAttr, escapeHtml } from "./utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type SelectOption = {
  value: string;
  label: string;
};

export type FileTransferViewState = {
  disabled: boolean;
  fileBrowserPath: string;
  selectedFileBrowserPath: string;
  fileBrowserEntries: FileBrowserEntry[];
  fileBrowserLoading: boolean;
  fileBrowserContextMenu: FileBrowserContextMenu | undefined;
  tr: Translate;
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
  sessionOptions: SelectOption[];
  selectedSessionId: string;
  tr: Translate;
};

export type PluginSettingsViewState = {
  plugins: PluginDescriptor[];
  pluginsLoading: boolean;
  savingPluginIds: Set<string>;
  aiAccess: AIAccessSettingsViewState;
  tr: Translate;
};

export type AIAccessSettingsViewState = {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  modelOptions: string[];
  mcpServers: AiMcpServerSettings[];
  activeTab: "ai" | "mcp";
  dialog: AIConfigDialogViewState | undefined;
  sendContext: boolean;
  contextLines: number;
};

export type AIConfigDialogViewState =
  | { type: "ai" }
  | { type: "mcp"; index: number; server: AiMcpServerSettings; headersText: string };

export function renderPluginSettingsView(state: PluginSettingsViewState): string {
  if (!state.plugins.length) {
    return `<div class="empty">${escapeHtml(state.tr(state.pluginsLoading ? "status.pluginsLoading" : "status.noPlugins"))}</div>`;
  }
  return state.plugins.map((plugin) => renderPluginSetting(plugin, state)).join("");
}

export function renderAIAccessSettingsView(
  state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate },
): string {
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
      ${activeTab === "mcp" ? renderMcpSettingsPanel(state) : renderAISettingsPanel(state)}
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

function renderAISettingsPanel(state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate }): string {
  const maskedKey = state.apiKey ? "••••••••" : state.tr("status.noTarget");
  const provider = aiProviderLabel(state.provider, state.tr);
  return `
    <div class="ai-config-summary" role="tabpanel">
      <div class="ai-config-summary-grid">
        ${renderSummaryItem(state.tr("field.aiProvider"), provider)}
        ${renderSummaryItem(state.tr("field.aiBaseUrl"), state.baseUrl || state.tr("status.noTarget"))}
        ${renderSummaryItem(state.tr("field.aiApiKey"), maskedKey)}
        ${renderSummaryItem(state.tr("field.aiModel"), state.model || state.tr("status.noTarget"))}
        ${renderSummaryItem(state.tr("setting.aiSendTerminalContext"), state.sendContext ? state.tr("status.aiContextReady", { lines: state.contextLines }) : state.tr("status.aiContextOff"))}
      </div>
      <p class="settings-help">${escapeHtml(state.tr("setting.aiPrivacyHelp"))}</p>
      <button class="command-button" type="button" data-ai-config-open="ai" ${state.disabled ? "disabled" : ""}>
        <i data-lucide="settings-2"></i>
        <span>${escapeHtml(state.tr("action.aiConfigure"))}</span>
      </button>
    </div>
  `;
}

function renderMcpSettingsPanel(state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate }): string {
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
  state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate },
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

function renderAIConfigDialog(state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate }): string {
  const dialog = state.dialog;
  if (!dialog) return "";
  const title = dialog.type === "mcp"
    ? dialog.index >= 0 ? state.tr("action.mcpEdit") : state.tr("action.mcpAdd")
    : state.tr("action.aiConfigure");
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

function renderAIProviderConfigForm(state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate }): string {
  const modelValues = state.modelOptions.includes(state.model) || !state.model
    ? state.modelOptions
    : [state.model, ...state.modelOptions];
  const modelOptions = modelValues
    .map((model) => `<option value="${escapeAttr(model)}">${escapeHtml(model)}</option>`)
    .join("");
  return `
    <div class="ai-config-grid">
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiProvider"))}</span>
        <select data-ai-dialog-field="provider">
          <option value="openai-compatible" ${state.provider === "openai-compatible" ? "selected" : ""}>${escapeHtml(state.tr("ai.providerOpenAICompatible"))}</option>
          <option value="openai-responses" ${state.provider === "openai-responses" ? "selected" : ""}>${escapeHtml(state.tr("ai.providerOpenAIResponses"))}</option>
          <option value="anthropic" ${state.provider === "anthropic" ? "selected" : ""}>${escapeHtml(state.tr("ai.providerAnthropic"))}</option>
        </select>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiBaseUrl"))}</span>
        <input data-ai-dialog-field="baseUrl" type="url" value="${escapeAttr(state.baseUrl)}" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiApiKey"))}</span>
        <input data-ai-dialog-field="apiKey" type="password" value="${escapeAttr(state.apiKey)}" autocomplete="off" spellcheck="false" />
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiModel"))}</span>
        <input data-ai-dialog-field="model" type="text" list="aiModelOptions" value="${escapeAttr(state.model)}" autocomplete="off" spellcheck="false" />
        <datalist id="aiModelOptions">${modelOptions}</datalist>
      </label>
      <label class="field checkbox-field">
        <input data-ai-dialog-field="sendContext" type="checkbox" ${state.sendContext ? "checked" : ""} />
        <span>${escapeHtml(state.tr("setting.aiSendTerminalContext"))}</span>
      </label>
      <label class="field">
        <span>${escapeHtml(state.tr("field.aiContextLines"))}</span>
        <input data-ai-dialog-field="contextLines" type="number" min="0" max="200" step="1" value="${escapeAttr(String(state.contextLines))}" />
      </label>
    </div>
  `;
}

function renderMcpConfigForm(
  dialog: Extract<AIConfigDialogViewState, { type: "mcp" }>,
  state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate },
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

function renderSummaryItem(label: string, value: string): string {
  return `
    <span class="ai-summary-item">
      <small>${escapeHtml(label)}</small>
      <strong>${escapeHtml(value)}</strong>
    </span>
  `;
}

export function renderFileTransferToolView(state: FileTransferViewState): string {
  const disabledAttr = state.disabled ? "disabled" : "";
  const currentPath = normalizeRemotePath(state.fileBrowserPath);
  const selectedPath = state.selectedFileBrowserPath || currentPath;
  const tr = state.tr;
  return `
    <div class="plugin-tool file-transfer-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(tr("section.fileTransfer"))}</div>
          <p class="settings-help">${escapeHtml(tr("plugin.fileTransfer.help"))}</p>
        </div>
      </div>
      <div class="file-browser-shell">
        <div class="file-browser-toolbar">
          <button class="icon-button" type="button" data-file-transfer-action="home" aria-label="${escapeAttr(tr("action.pluginFileHome"))}" title="${escapeAttr(tr("action.pluginFileHome"))}" ${disabledAttr}>
            <i data-lucide="hard-drive"></i>
          </button>
          <button class="icon-button" type="button" data-file-transfer-action="parent" aria-label="${escapeAttr(tr("action.pluginFileParent"))}" title="${escapeAttr(tr("action.pluginFileParent"))}" ${disabledAttr}>
            <i data-lucide="corner-up-left"></i>
          </button>
          <button class="icon-button" type="button" data-file-transfer-action="refresh" aria-label="${escapeAttr(tr("action.pluginFileRefresh"))}" title="${escapeAttr(tr("action.pluginFileRefresh"))}" ${disabledAttr}>
            <i data-lucide="refresh-cw"></i>
          </button>
          <button class="icon-button" type="button" data-file-transfer-action="sync-cwd" aria-label="${escapeAttr(tr("action.pluginFileSyncCwd"))}" title="${escapeAttr(tr("action.pluginFileSyncCwd"))}" ${disabledAttr}>
            <i data-lucide="locate-fixed"></i>
          </button>
          <div class="file-browser-path" title="${escapeAttr(currentPath)}">${escapeHtml(currentPath)}</div>
        </div>
        <div class="file-browser-list" role="listbox" aria-label="${escapeAttr(tr("section.fileTransfer"))}">
          ${renderFileBrowserEntries(state)}
        </div>
        ${renderFileBrowserContextMenu(state)}
      </div>
      <div class="file-browser-footer">
        <div class="file-browser-selection" title="${escapeAttr(selectedPath)}">
          <span>${escapeHtml(selectedPath)}</span>
        </div>
        <div class="file-browser-actions" aria-label="${escapeAttr(tr("section.fileTransfer"))}">
          <button class="file-action-button" type="button" data-file-transfer-action="download" aria-label="${escapeAttr(tr("action.pluginFileDownload"))}" title="${escapeAttr(tr("action.pluginFileDownload"))}" ${disabledAttr}>
            <i data-lucide="download"></i>
            <span class="file-action-tip">${escapeHtml(tr("action.pluginFileDownload"))}</span>
          </button>
          <button class="file-action-button" type="button" data-file-transfer-action="read" aria-label="${escapeAttr(tr("action.pluginFileRead"))}" title="${escapeAttr(tr("action.pluginFileRead"))}" ${disabledAttr}>
            <i data-lucide="file-text"></i>
            <span class="file-action-tip">${escapeHtml(tr("action.pluginFileRead"))}</span>
          </button>
          <button class="file-action-button" type="button" data-file-transfer-action="stat" aria-label="${escapeAttr(tr("action.pluginFileStat"))}" title="${escapeAttr(tr("action.pluginFileStat"))}" ${disabledAttr}>
            <i data-lucide="info"></i>
            <span class="file-action-tip">${escapeHtml(tr("action.pluginFileStat"))}</span>
          </button>
          <label class="file-action-button ${state.disabled ? "is-disabled" : ""}" aria-label="${escapeAttr(tr("action.pluginFileUpload"))}" title="${escapeAttr(tr("action.pluginFileUpload"))}">
            <input data-file-upload type="file" multiple ${disabledAttr} />
            <i data-lucide="upload"></i>
            <span class="file-action-tip">${escapeHtml(tr("action.pluginFileUpload"))}</span>
          </label>
        </div>
      </div>
      <pre class="plugin-output file-browser-preview" id="fileTransferOutput" aria-label="${escapeAttr(tr("plugin.fileTransfer.output"))}"></pre>
    </div>
  `;
}

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
            ${renderAIChatPicker({
              field: "model",
              label: tr("field.aiModel"),
              options: state.modelOptions,
              selected: state.selectedModel,
              disabled: state.disabled,
            })}
            ${renderAIChatPicker({
              field: "session",
              label: tr("field.aiSession"),
              options: state.sessionOptions,
              selected: state.selectedSessionId,
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

export function renderAIChatMessages(state: Pick<AIChatViewState, "messages" | "streaming" | "tr">): string {
  if (!state.messages.length) {
    return `<div class="empty">${escapeHtml(state.tr("plugin.aiChat.description"))}</div>`;
  }
  return state.messages.map((message, index) => {
    const thinking = message.role === "assistant" && !message.content.trim() && state.streaming;
    const content = thinking
      ? `<div class="ai-thinking" role="status" aria-label="${escapeAttr(state.tr("status.aiWorking"))}"><span class="ai-thinking-leds" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>`
      : escapeHtml(message.content);
    return `
    <article class="ai-chat-message ${escapeAttr(message.role)}" data-tone="${escapeAttr(message.tone ?? "neutral")}">
      <div class="ai-chat-message-head">
        <span class="ai-chat-message-role">${escapeHtml(aiChatRoleLabel(message.role))}</span>
        ${message.content.trim() ? `<button class="ai-message-copy" type="button" data-ai-action="copy-message" data-ai-message-index="${escapeAttr(String(index))}" aria-label="${escapeAttr(state.tr("action.aiCopy"))}" title="${escapeAttr(state.tr("action.aiCopy"))}"><i data-lucide="copy"></i></button>` : ""}
      </div>
      <div class="ai-chat-message-content ${thinking ? "is-thinking" : ""}">${content}</div>
    </article>
  `;
  }).join("");
}

export function aiChatTranscript(session: AIChatSession): string {
  return session.messages
    .map((message) => `## ${aiChatRoleLabel(message.role)}\n\n${message.content}`)
    .join("\n\n");
}

function renderPluginSetting(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  const saving = state.savingPluginIds.has(plugin.id);
  const status = plugin.enabled ? state.tr("setting.pluginEnabled") : state.tr("setting.pluginDisabled");
  const meta = Array.from(new Set([plugin.kind, ...plugin.scopes].filter(Boolean)))
    .map((item) => pluginMetaLabel(item, state.tr));
  const settingsTool = plugin.id === AI_CHAT_PLUGIN_ID
    ? renderAIAccessSettingsView({
      ...state.aiAccess,
      disabled: !plugin.enabled || saving || state.pluginsLoading,
      tr: state.tr,
    })
    : "";
  return `
    <div class="plugin-item" role="listitem">
      <div class="plugin-content">
        <div class="plugin-title-row">
          <span class="plugin-icon"><i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i></span>
          <span class="plugin-name">${escapeHtml(pluginDisplayName(plugin, state.tr))}</span>
          <code>${escapeHtml(plugin.id)}</code>
        </div>
        <p class="plugin-description">${escapeHtml(pluginDescription(plugin, state.tr))}</p>
        <div class="plugin-meta">
          ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
      <label class="switch plugin-switch">
        <input
          type="checkbox"
          data-plugin-toggle="${escapeAttr(plugin.id)}"
          ${plugin.enabled ? "checked" : ""}
          ${saving || state.pluginsLoading ? "disabled" : ""}
        />
        <span>${escapeHtml(status)}</span>
      </label>
      ${settingsTool}
    </div>
  `;
}

function renderFileBrowserEntries(state: FileTransferViewState): string {
  if (state.fileBrowserLoading) {
    return `<div class="empty">${escapeHtml(state.tr("status.pluginsLoading"))}</div>`;
  }
  if (!state.fileBrowserEntries.length) {
    return `<div class="empty">${escapeHtml(state.tr("status.pluginFileEmpty"))}</div>`;
  }
  return state.fileBrowserEntries.map((entry) => {
    const selected = entry.path === state.selectedFileBrowserPath;
    const details = entry.linkTarget
      ? `${fileKindLabel(entry.kind, state.tr)} -> ${entry.linkTarget}`
      : `${fileKindLabel(entry.kind, state.tr)} · ${formatFileSize(entry.size)}`;
    return `
      <button
        class="file-browser-entry ${selected ? "selected" : ""}"
        type="button"
        role="option"
        aria-selected="${selected}"
        data-file-entry="${escapeAttr(entry.path)}"
        title="${escapeAttr(entry.path)}"
        ${state.disabled ? "disabled" : ""}
      >
        <span class="file-browser-entry-icon" data-kind="${escapeAttr(entry.kind)}">
          <i data-lucide="${escapeAttr(fileEntryIcon(entry))}"></i>
        </span>
        <span class="file-browser-entry-main">
          <strong>${escapeHtml(entry.name)}</strong>
          <small>${escapeHtml(details)}</small>
        </span>
      </button>
    `;
  }).join("");
}

function renderFileBrowserContextMenu(state: FileTransferViewState): string {
  if (!state.fileBrowserContextMenu || state.disabled) return "";
  const entry = state.fileBrowserEntries.find((item) => item.path === state.fileBrowserContextMenu?.path);
  const path = entry?.path ?? state.fileBrowserContextMenu.path;
  const canOpen = entry?.kind === "directory" || entry?.kind === "symlink";
  const tr = state.tr;
  return `
    <div class="file-browser-context-menu" style="left:${state.fileBrowserContextMenu.x}px;top:${state.fileBrowserContextMenu.y}px" role="menu">
      ${canOpen ? `
        <button type="button" role="menuitem" data-file-menu-action="open" data-file-menu-path="${escapeAttr(path)}">
          <i data-lucide="folder-open"></i><span>${escapeHtml(tr("action.pluginFileOpen"))}</span>
        </button>
      ` : ""}
      <button type="button" role="menuitem" data-file-menu-action="download" data-file-menu-path="${escapeAttr(path)}">
        <i data-lucide="download"></i><span>${escapeHtml(tr("action.pluginFileDownload"))}</span>
      </button>
      <button type="button" role="menuitem" data-file-menu-action="read" data-file-menu-path="${escapeAttr(path)}">
        <i data-lucide="file-text"></i><span>${escapeHtml(tr("action.pluginFileRead"))}</span>
      </button>
      <button type="button" role="menuitem" data-file-menu-action="stat" data-file-menu-path="${escapeAttr(path)}">
        <i data-lucide="info"></i><span>${escapeHtml(tr("action.pluginFileStat"))}</span>
      </button>
      <label role="menuitem" class="file-menu-upload">
        <input data-file-upload type="file" multiple />
        <i data-lucide="upload"></i><span>${escapeHtml(tr("action.pluginFileUpload"))}</span>
      </label>
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

function aiProviderLabel(provider: string, tr: Translate): string {
  if (provider === "openai-responses") return tr("ai.providerOpenAIResponses");
  if (provider === "anthropic") return tr("ai.providerAnthropic");
  return tr("ai.providerOpenAICompatible");
}

function mcpTransportLabel(transport: AiMcpServerSettings["transport"], tr: Translate): string {
  return transport === "sse" ? tr("mcp.transportSse") : tr("mcp.transportHttp");
}

function fileKindLabel(kind: FileBrowserEntry["kind"], tr: Translate): string {
  if (kind === "directory") return tr("fileKind.directory");
  if (kind === "symlink") return tr("fileKind.symlink");
  if (kind === "hardlink") return tr("fileKind.hardlink");
  if (kind === "file") return tr("fileKind.file");
  return tr("fileKind.other");
}
