import type { MessageKey } from "./i18n";
import { fileEntryIcon, formatFileSize, normalizeRemotePath } from "./remote-files";
import type { AIChatMessage, AIChatSession, FileBrowserContextMenu, FileBrowserEntry } from "./types";
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

function fileKindLabel(kind: FileBrowserEntry["kind"], tr: Translate): string {
  if (kind === "directory") return tr("fileKind.directory");
  if (kind === "symlink") return tr("fileKind.symlink");
  if (kind === "hardlink") return tr("fileKind.hardlink");
  if (kind === "file") return tr("fileKind.file");
  return tr("fileKind.other");
}
