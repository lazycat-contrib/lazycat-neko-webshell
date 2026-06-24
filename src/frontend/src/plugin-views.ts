import type { MessageKey } from "./i18n";
import type { PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import { renderAIChatContextToggle } from "./ai-chat/options-view";
import { renderChatMarkdown } from "./chat-markdown";
import {
  AI_CHAT_PLUGIN_ID,
  LIGHTOS_PORT_FORWARD_PLUGIN_ID,
  pluginDescription,
  pluginDisplayName,
  pluginIcon,
  pluginMetaLabel,
  PUBLIC_TUNNEL_PLUGIN_ID,
} from "./plugin-utils";
import { fileEntryIcon, formatFileSize, normalizeRemotePath } from "./remote-files";
import type { AIChatMessage, AIChatSession, AiMcpServerSettings, AiProviderProfile, FileBrowserContextMenu, FileBrowserEntry } from "./types";
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
  providerProfiles: AiProviderProfile[];
  activeProviderProfileId: string;
  providerPickerOpen: boolean;
  sendTerminalContext: boolean;
  terminalContextPreview: string;
  tr: Translate;
};

export type LightOsForwardInfo = {
  id: string;
  selector: string;
  localHost: string;
  localPort: number;
  localUrl: string;
  remoteHost: string;
  remotePort: number;
  status: string;
  createdAtMs: number;
};

export type PublicTunnelInfo = {
  id: string;
  provider: string;
  publicUrl: string;
  upstreamUrl: string;
  status: string;
  createdAtMs: number;
};

export type LightOsPortForwardViewState = {
  disabled: boolean;
  remoteHost: string;
  remotePort: string;
  forwards: LightOsForwardInfo[];
  loading: boolean;
  output: string;
  tr: Translate;
};

export type PublicTunnelViewState = {
  disabled: boolean;
  provider: string;
  upstreamUrl: string;
  ngrokAuthtoken: string;
  tunnels: PublicTunnelInfo[];
  forwards: LightOsForwardInfo[];
  loading: boolean;
  output: string;
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
  profiles: AiProviderProfile[];
  activeProfileId: string;
  mcpServers: AiMcpServerSettings[];
  activeTab: "ai" | "mcp";
  dialog: AIConfigDialogViewState | undefined;
};

export type AIConfigDialogViewState =
  | { type: "ai"; profile: AiProviderProfile; isNew: boolean }
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

function renderAIProviderConfigForm(state: AIAccessSettingsViewState & { disabled: boolean; tr: Translate }): string {
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
            ${renderAIProviderPicker(state)}
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

export function renderLightOsPortForwardToolView(state: LightOsPortForwardViewState): string {
  const disabledAttr = state.disabled || state.loading ? "disabled" : "";
  return `
    <div class="plugin-tool network-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(state.tr("plugin.lightosPortForward.name"))}</div>
          <p class="settings-help">${escapeHtml(state.tr("plugin.lightosPortForward.help"))}</p>
        </div>
      </div>
      <div class="network-form-grid">
        <label class="field">
          <span>${escapeHtml(state.tr("field.remoteHost"))}</span>
          <input data-port-forward-field="remoteHost" type="text" value="${escapeAttr(state.remoteHost)}" autocomplete="off" spellcheck="false" ${disabledAttr} />
        </label>
        <label class="field">
          <span>${escapeHtml(state.tr("field.remotePort"))}</span>
          <input data-port-forward-field="remotePort" type="number" min="1" max="65535" inputmode="numeric" value="${escapeAttr(state.remotePort)}" ${disabledAttr} />
        </label>
        <div class="network-actions">
          <button class="command-button primary" type="button" data-port-forward-action="acquire" ${disabledAttr}>
            <i data-lucide="waypoints"></i>
            <span>${escapeHtml(state.tr("action.portForwardAcquire"))}</span>
          </button>
          <button class="command-button" type="button" data-port-forward-action="list" ${state.disabled || state.loading ? "disabled" : ""}>
            <i data-lucide="refresh-cw"></i>
            <span>${escapeHtml(state.tr("action.refresh"))}</span>
          </button>
        </div>
      </div>
      ${renderLightOsForwardList(state)}
      ${state.output ? `<pre class="plugin-output network-output">${escapeHtml(state.output)}</pre>` : ""}
    </div>
  `;
}

export function renderPublicTunnelToolView(state: PublicTunnelViewState): string {
  const disabledAttr = state.disabled || state.loading ? "disabled" : "";
  const ngrokSelected = state.provider === "ngrok";
  return `
    <div class="plugin-tool network-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(state.tr("plugin.publicTunnel.name"))}</div>
          <p class="settings-help">${escapeHtml(state.tr("plugin.publicTunnel.help"))}</p>
        </div>
      </div>
      <div class="network-form-grid">
        <label class="field">
          <span>${escapeHtml(state.tr("field.tunnelProvider"))}</span>
          <select data-public-tunnel-field="provider" ${disabledAttr}>
            <option value="cloudflare-quick" ${state.provider === "cloudflare-quick" ? "selected" : ""}>Cloudflare Quick Tunnel</option>
            <option value="ngrok" ${ngrokSelected ? "selected" : ""}>ngrok</option>
          </select>
        </label>
        <label class="field network-field-wide">
          <span>${escapeHtml(state.tr("field.upstreamUrl"))}</span>
          <input data-public-tunnel-field="upstreamUrl" type="url" value="${escapeAttr(state.upstreamUrl)}" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:3000/" ${disabledAttr} />
        </label>
        <label class="field network-field-wide ${ngrokSelected ? "" : "is-muted"}">
          <span>${escapeHtml(state.tr("field.ngrokAuthtoken"))}</span>
          <input data-public-tunnel-field="ngrokAuthtoken" type="password" value="${escapeAttr(state.ngrokAuthtoken)}" autocomplete="off" spellcheck="false" ${disabledAttr} />
        </label>
        <div class="network-actions">
          <button class="command-button primary" type="button" data-public-tunnel-action="start" ${disabledAttr}>
            <i data-lucide="radio-tower"></i>
            <span>${escapeHtml(state.tr("action.tunnelStart"))}</span>
          </button>
          <button class="command-button" type="button" data-public-tunnel-action="list" ${state.disabled || state.loading ? "disabled" : ""}>
            <i data-lucide="refresh-cw"></i>
            <span>${escapeHtml(state.tr("action.refresh"))}</span>
          </button>
        </div>
      </div>
      ${renderForwardPickerForTunnel(state)}
      ${renderPublicTunnelList(state)}
      ${state.output ? `<pre class="plugin-output network-output">${escapeHtml(state.output)}</pre>` : ""}
    </div>
  `;
}

function renderLightOsForwardList(state: LightOsPortForwardViewState): string {
  if (state.loading && !state.forwards.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.pluginsLoading"))}</div>`;
  }
  if (!state.forwards.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.noPortForwards"))}</div>`;
  }
  return `
    <div class="network-list" role="list">
      ${state.forwards.map((forward) => `
        <article class="network-item" role="listitem">
          <span class="network-item-main">
            <strong>${escapeHtml(forward.localUrl)}</strong>
            <small>${escapeHtml(`${forward.remoteHost}:${forward.remotePort} -> ${forward.localHost}:${forward.localPort}`)}</small>
          </span>
          <span class="network-badge">${escapeHtml(forward.status)}</span>
          <span class="network-item-actions">
            <button class="icon-button" type="button" data-network-copy="${escapeAttr(forward.localUrl)}" aria-label="${escapeAttr(state.tr("action.copyUrl"))}" title="${escapeAttr(state.tr("action.copyUrl"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button" type="button" data-port-forward-use-tunnel="${escapeAttr(forward.localUrl)}" aria-label="${escapeAttr(state.tr("action.useForTunnel"))}" title="${escapeAttr(state.tr("action.useForTunnel"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="radio-tower"></i>
            </button>
            <button class="icon-button" type="button" data-port-forward-release="${escapeAttr(forward.id)}" aria-label="${escapeAttr(state.tr("action.portForwardRelease"))}" title="${escapeAttr(state.tr("action.portForwardRelease"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="x"></i>
            </button>
          </span>
        </article>
      `).join("")}
    </div>
  `;
}

function renderForwardPickerForTunnel(state: PublicTunnelViewState): string {
  if (!state.forwards.length) return "";
  return `
    <div class="network-forward-picks" aria-label="${escapeAttr(state.tr("plugin.lightosPortForward.name"))}">
      ${state.forwards.map((forward) => `
        <button type="button" class="network-forward-pick" data-public-tunnel-upstream="${escapeAttr(forward.localUrl)}" ${state.disabled ? "disabled" : ""}>
          <i data-lucide="waypoints"></i>
          <span>${escapeHtml(`${forward.remoteHost}:${forward.remotePort}`)}</span>
          <small>${escapeHtml(forward.localUrl)}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function renderPublicTunnelList(state: PublicTunnelViewState): string {
  if (state.loading && !state.tunnels.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.pluginsLoading"))}</div>`;
  }
  if (!state.tunnels.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.noPublicTunnels"))}</div>`;
  }
  return `
    <div class="network-list" role="list">
      ${state.tunnels.map((tunnel) => `
        <article class="network-item" role="listitem">
          <span class="network-item-main">
            <strong>${escapeHtml(tunnel.publicUrl)}</strong>
            <small>${escapeHtml(`${tunnel.provider} -> ${tunnel.upstreamUrl}`)}</small>
          </span>
          <span class="network-badge">${escapeHtml(tunnel.status)}</span>
          <span class="network-item-actions">
            <button class="icon-button" type="button" data-network-copy="${escapeAttr(tunnel.publicUrl)}" aria-label="${escapeAttr(state.tr("action.copyUrl"))}" title="${escapeAttr(state.tr("action.copyUrl"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button" type="button" data-public-tunnel-stop="${escapeAttr(tunnel.id)}" aria-label="${escapeAttr(state.tr("action.tunnelStop"))}" title="${escapeAttr(state.tr("action.tunnelStop"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="x"></i>
            </button>
          </span>
        </article>
      `).join("")}
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

export function renderAIChatMessages(state: Pick<AIChatViewState, "messages" | "streaming" | "sendTerminalContext" | "terminalContextPreview" | "tr">): string {
  if (!state.messages.length) {
    return `<div class="empty">${escapeHtml(state.tr("plugin.aiChat.description"))}</div>`;
  }
  return state.messages.map((message, index) => {
    const thinking = message.role === "assistant" && !message.content.trim() && state.streaming;
    const markdown = !thinking && message.role !== "user";
    const content = thinking
      ? `<div class="ai-thinking" role="status" aria-label="${escapeAttr(state.tr("status.aiWorking"))}"><span class="ai-thinking-leds" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>`
      : markdown ? renderChatMarkdown(message.content, { copyLabel: state.tr("action.aiCopy") }) : escapeHtml(message.content);
    const contentClass = [
      "ai-chat-message-content",
      thinking ? "is-thinking" : "",
      markdown ? "ai-chat-markdown" : "",
    ].filter(Boolean).join(" ");
    return `
    <article class="ai-chat-message ${escapeAttr(message.role)}" data-tone="${escapeAttr(message.tone ?? "neutral")}">
      <div class="ai-chat-message-head">
        <span class="ai-chat-avatar" aria-hidden="true"><i data-lucide="${escapeAttr(aiChatRoleIcon(message.role))}"></i></span>
        <span class="ai-chat-message-role">${escapeHtml(aiChatRoleLabel(message.role))}</span>
        ${message.role === "assistant" ? renderAIContextLcd(state) : ""}
        ${message.content.trim() ? `<button class="ai-message-copy" type="button" data-ai-action="copy-message" data-ai-message-index="${escapeAttr(String(index))}" aria-label="${escapeAttr(state.tr("action.aiCopy"))}" title="${escapeAttr(state.tr("action.aiCopy"))}"><i data-lucide="copy"></i></button>` : ""}
      </div>
      <div class="${escapeAttr(contentClass)}">${content}</div>
    </article>
  `;
  }).join("");
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

function emptyAiProviderProfile(): AiProviderProfile {
  return {
    id: "",
    name: "",
    provider: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    model: "",
  };
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
