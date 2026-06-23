import "./styles.css";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createIcons, icons } from "lucide";
import { Terminal } from "restty/xterm";

import { TerminalActionWSClient, type ActionResponseMeta } from "./action-ws-client";
import {
  DEFAULT_SETTINGS,
  FONT_EXTENSIONS,
  FONT_MIME_TYPES,
  FONT_PRESETS,
  INTERFACE_STYLE_IDS,
  INITIAL_COLS,
  INITIAL_ROWS,
  MAX_CLIPBOARD_IMAGE_BYTES,
  MAX_CUSTOM_THEME_SOURCE_BYTES,
  MAX_OUTPUT_BUFFER_LIMIT,
  MAX_FONT_BYTES,
  MAX_TERMINAL_BACKGROUND_BYTES,
  MIN_OUTPUT_BUFFER_LIMIT,
  STATUS_REFRESH_MS,
  TERMINAL_BACKGROUND_EXTENSIONS,
  TERMINAL_BACKGROUND_MIME_TYPES,
  THEMES,
} from "./config";
import { resttyFontSourcesFor, storedFontToResttyPreset } from "./font-registry";
import { CapabilityService, type Instance, type PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import { translate, type MessageKey } from "./i18n";
import { encodeMobileShortcutKeyInput, encodeModifiedTextInput } from "./keyboard";
import { loadLocalSettings, loadSettings, saveSettings as persistSettings } from "./settings";
import { renderShell } from "./shell";
import { paneLayoutNode } from "./split-layout";
import { cursorStyleSequence, terminalThemeCssVars, withTransparentBackground } from "./terminal-appearance";
import { MAX_PENDING_INPUT_BYTES, monotonicSequence, parseTerminalServerMessage } from "./terminal-protocol";
import { builtInGhosttyThemes, CUSTOM_THEME_PREFIX, parseCustomGhosttyTheme, resolveTheme, resttyThemeFor } from "./theme-registry";
import type {
  FontPreset,
  HerdrAction,
  HerdrBridgeState,
  HerdrTabInfo,
  HerdrWorkspaceInfo,
  InterfaceStyleId,
  PaneTerminalTransport,
  SessionBackendId,
  SessionBackendInfo,
  SessionBackendsState,
  SplitNode,
  SplitPlacement,
  StoredFont,
  TerminalBackground,
  TerminalPane,
  TerminalTab,
  TerminalTheme,
  Tone,
  WorkspaceAction,
  WorkspacePaneState,
  WorkspaceState,
} from "./types";
import { clampNumber, errorMessage, escapeAttr, escapeHtml, newId, qs, selectorLabel } from "./utils";

const terminalEncoder = new TextEncoder();
const REPLAY_INPUT_LOCK_TIMEOUT_MS = 5000;
const TERMINAL_SIZE_REFRESH_DELAYS_MS = [80, 250, 600] as const;
const MOBILE_KEYBOARD_INSET_THRESHOLD_PX = 80;
const MOBILE_TERMINAL_TAP_MOVE_THRESHOLD_PX = 18;
const MOBILE_TERMINAL_DOUBLE_TAP_DISTANCE_PX = 32;
const MOBILE_TERMINAL_DOUBLE_TAP_DELAY_MS = 420;
const MOBILE_TERMINAL_TAB_SWIPE_DISTANCE_PX = 72;
const MOBILE_TERMINAL_TAB_SWIPE_RATIO = 1.6;
const MOBILE_TERMINAL_TAB_SWIPE_MAX_MS = 700;
const MOBILE_TERMINAL_SCROLL_LOCK_THRESHOLD_PX = 8;
const MOBILE_TERMINAL_SCROLL_AXIS_RATIO = 1.1;
const MAX_AI_CONTEXT_CHARS = 12000;
const LAST_SELECTOR_STORAGE_KEY = "lazycat-neko-webshell.lastSelector";
const LAST_TAB_STORAGE_PREFIX = "lazycat-neko-webshell.lastTab";
const FILE_TRANSFER_PLUGIN_ID = "file-transfer";
const AI_CHAT_PLUGIN_ID = "ai-chat";
const LIGHT_INTERFACE_STYLES = new Set<InterfaceStyleId>(["porcelain", "frost", "champagne", "candy", "lab"]);
const HERDR_SPLIT_DIRECTIONS: Partial<Record<SplitPlacement, "right" | "down">> = {
  right: "right",
  down: "down",
};
const ZELLIJ_SPLIT_KEYS: Partial<Record<SplitPlacement, string>> = {
  right: "r",
  down: "d",
};
const ZELLIJ_PANE_MODE_PREFIX = "\x10";
const capabilityClient = createClient(
  CapabilityService,
  createConnectTransport({
    baseUrl: "/",
    fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
  }),
);
const actionClient = new TerminalActionWSClient();

type SessionMode = SessionBackendId;
type FileBrowserEntry = {
  name: string;
  path: string;
  kind: "directory" | "file" | "symlink" | "hardlink" | "other";
  size: number;
  linkTarget?: string;
};
type AIChatMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  tone?: Tone;
};
type AIChatSession = {
  id: string;
  model: string;
  title: string;
  messages: AIChatMessage[];
};
type FileBrowserContextMenu = {
  path: string;
  x: number;
  y: number;
};
type ClipboardImagePayload = {
  extension: string;
  data: ArrayBuffer;
};
type JsonRecord = Record<string, unknown>;
type HerdrSocketEnvelope = {
  id?: string;
  result?: JsonRecord;
  error?: {
    code?: string;
    message?: string;
  };
  event?: string;
  data?: JsonRecord;
};

const params = new URLSearchParams(window.location.search);
const initialSelector = normalizeSelector(params.get("name") ?? "");
const initialSelectorExplicit = params.has("name") && Boolean(initialSelector);

const elements = renderShell(qs<HTMLDivElement>("#app"));

let settings = loadLocalSettings();
let instances: Instance[] = [];
let selectedSelector = initialSelector;
let selectedSelectorGeneration = 0;
let selectedSelectorExplicit = initialSelectorExplicit;
let herdrState: HerdrBridgeState | undefined;
let herdrStateGeneration = 0;
let herdrEventSocket: WebSocket | undefined;
let herdrEventSocketSelector = "";
let herdrEventSocketGeneration = 0;
let herdrEventReconnectTimer: number | undefined;
let herdrEventRefreshTimer: number | undefined;
let sessionBackendsState: SessionBackendsState | undefined;
let sessionBackendsGeneration = 0;
const herdrAutoRestoredSelectors = new Set<string>();
let plugins: PluginDescriptor[] = [];
let pluginsLoaded = false;
let pluginsLoading = false;
let activePluginToolId = "";
let aiModelOptions: string[] = [];
let fileBrowserPath = "/";
let selectedFileBrowserPath = "";
let fileBrowserEntries: FileBrowserEntry[] = [];
let fileBrowserLoading = false;
let fileBrowserLoadedPath = "";
let fileBrowserPaneId = "";
let fileBrowserContextMenu: FileBrowserContextMenu | undefined;
let aiChatSessions: AIChatSession[] = [];
let activeAIChatSessionId = "";
let aiChatStreaming = false;
let tabs: TerminalTab[] = [];
let activeTabId: string | undefined;
let renamingTabId: string | undefined;
let contextPaneId: string | undefined;
let customFonts: FontPreset[] = [];
const mobileSticky = {
  ctrl: false,
  alt: false,
  shift: false,
};
const lastMobileTerminalTap = {
  paneId: "",
  time: 0,
  x: 0,
  y: 0,
};
const mobileTerminalSwipe = {
  paneId: "",
  x: 0,
  y: 0,
  time: 0,
};
const pluginSaveInFlight = new Set<string>();
let mobileRepeatTimer: number | undefined;
let mobileRepeatInterval: number | undefined;
let terminalResizeTimers: number[] = [];

updateViewportMetrics();
init().catch((error) => setGlobalStatus(tr("status.startupFailed", { message: errorMessage(error) }), "error"));

async function init() {
  updateViewportMetrics();
  settings = await loadSettings();
  await loadUploadedFonts();
  renderOptions();
  bindSettings();
  bindActions();
  applySettings();
  void document.fonts?.ready.then(() => handleViewportChange()).catch(() => {});
  createIcons({ icons });
  setInterval(updateActiveDetails, STATUS_REFRESH_MS);
  await loadInstances();
  if (selectedSelector) {
    await loadWorkspace(selectedSelector);
  }
  if (selectedSelector && !tabs.length) {
    elements.targetLabel.textContent = selectorLabel(selectedSelector);
  }
}

function saveSettings() {
  persistSettings(settings);
}

function tr(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(settings.locale, key, values);
}

function normalizeSelector(value: unknown): string {
  return String(value ?? "").trim();
}

function instanceSelector(instance: Instance | undefined): string {
  const explicit = normalizeSelector(instance?.selector);
  if (explicit) return explicit;
  const name = normalizeSelector(instance?.name);
  const ownerDeployId = normalizeSelector(instance?.ownerDeployId);
  return name && ownerDeployId ? `${name}@${ownerDeployId}` : "";
}

function isRunningInstance(instance: Instance | undefined): boolean {
  return Boolean(
    instance
      && normalizeSelector(instance.status) === "running"
      && instanceSelector(instance),
  );
}

function setSelectedSelector(
  selector: string,
  options: {
    replaceLocation?: boolean;
    tabId?: string;
    updateLocation?: boolean;
  } = {},
): number {
  const normalized = normalizeSelector(selector);
  if (normalized !== selectedSelector) {
    selectedSelector = normalized;
    selectedSelectorGeneration += 1;
  }
  if (options.updateLocation !== false && selectedSelector) {
    updateWorkspaceLocation(selectedSelector, {
      replace: options.replaceLocation ?? true,
      tabId: options.tabId,
    });
  }
  return selectedSelectorGeneration;
}

function isCurrentSelectorRequest(selector: string, generation: number): boolean {
  return normalizeSelector(selector) === selectedSelector && generation === selectedSelectorGeneration;
}

function updateWorkspaceLocation(
  selector: string,
  options: {
    replace?: boolean;
    tabId?: string;
  } = {},
) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return;
  const url = new URL(window.location.href);
  url.searchParams.set("name", normalized);
  const tabId = normalizeSelector(options.tabId ?? activeTabId ?? "");
  if (tabId) {
    url.searchParams.set("tab", tabId);
  } else {
    url.searchParams.delete("tab");
  }
  const state = window.history.state && typeof window.history.state === "object" ? window.history.state : {};
  const nextState: Record<string, unknown> = { ...state, name: normalized };
  if (tabId) {
    nextState.tab = tabId;
  } else {
    delete nextState.tab;
  }
  if (options.replace === false) {
    window.history.pushState(nextState, "", url);
    return;
  }
  window.history.replaceState(nextState, "", url);
}

function requestedTabIdFromLocation(): string {
  return normalizeSelector(new URLSearchParams(window.location.search).get("tab") ?? "");
}

function lastTabStorageKey(selector: string): string {
  return `${LAST_TAB_STORAGE_PREFIX}.${selector}`;
}

function readRememberedTabId(selector: string): string {
  try {
    return normalizeSelector(window.localStorage.getItem(lastTabStorageKey(selector)) ?? "");
  } catch {
    return "";
  }
}

function readRememberedSelector(): string {
  try {
    return normalizeSelector(window.localStorage.getItem(LAST_SELECTOR_STORAGE_KEY) ?? "");
  } catch {
    return "";
  }
}

function rememberSelector(selector: string) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return;
  try {
    window.localStorage.setItem(LAST_SELECTOR_STORAGE_KEY, normalized);
  } catch {
    // localStorage is best-effort; URL and server workspace state remain authoritative.
  }
}

function rememberActiveTab() {
  if (!selectedSelector || !activeTabId) return;
  try {
    window.localStorage.setItem(lastTabStorageKey(selectedSelector), activeTabId);
  } catch {
    // localStorage is best-effort; workspace persistence remains server-owned.
  }
  updateWorkspaceLocation(selectedSelector, { replace: true, tabId: activeTabId });
}

function firstExistingTabId(candidates: Array<string | undefined>): string | undefined {
  return candidates.map(normalizeSelector).find((tabId) => tabs.some((tab) => tab.id === tabId));
}

function applyI18n() {
  document.documentElement.lang = settings.locale === "zh-CN" ? "zh-CN" : settings.locale === "en" ? "en" : navigator.language || "en";
  document.querySelectorAll<HTMLElement>("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n as MessageKey | undefined;
    if (key) element.textContent = tr(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-title]").forEach((element) => {
    const key = element.dataset.i18nTitle as MessageKey | undefined;
    if (key) element.title = tr(key);
  });
  document.querySelectorAll<HTMLElement>("[data-i18n-aria]").forEach((element) => {
    const key = element.dataset.i18nAria as MessageKey | undefined;
    if (key) element.setAttribute("aria-label", tr(key));
  });
}

function renderOptions() {
  renderThemeOptions();
  const customOptions = customFonts.map(
    (font) => `<option value="${font.id}">${escapeHtml(font.label)}</option>`,
  ).join("");
  elements.fontFamily.innerHTML = `
    <optgroup label="${escapeAttr(tr("font.builtIn"))}">
      ${FONT_PRESETS.map((font) => `<option value="${font.id}">${font.label}</option>`).join("")}
    </optgroup>
    <optgroup label="${escapeAttr(tr("font.uploaded"))}">
      ${customOptions || `<option disabled>${escapeHtml(tr("font.noUploaded"))}</option>`}
    </optgroup>
  `;
}

function renderThemeOptions() {
  const recommended = THEMES.map(
    (theme) => `<option value="${escapeAttr(theme.id)}">${escapeHtml(theme.label)}</option>`,
  ).join("");
  const builtIn = builtInGhosttyThemes().map(
    (theme) => `<option value="${escapeAttr(theme.id)}">${escapeHtml(theme.label)}</option>`,
  ).join("");
  const custom = settings.customThemes.map(
    (theme) => `<option value="${escapeAttr(theme.id)}">${escapeHtml(theme.label)}</option>`,
  ).join("");
  elements.themeSelect.innerHTML = `
    <optgroup label="${escapeAttr(tr("theme.recommended"))}">
      ${recommended}
    </optgroup>
    <optgroup label="${escapeAttr(tr("theme.builtIn"))}">
      ${builtIn}
    </optgroup>
    <optgroup label="${escapeAttr(tr("theme.custom"))}">
      ${custom || `<option disabled>${escapeHtml(tr("theme.noCustom"))}</option>`}
    </optgroup>
  `;
}

function bindSettings() {
  elements.localeSelect.addEventListener("change", () => {
    settings.locale = elements.localeSelect.value === "en" || elements.localeSelect.value === "zh-CN"
      ? elements.localeSelect.value
      : "auto";
    saveSettings();
    renderOptions();
    applySettings();
  });
  elements.themeSelect.addEventListener("change", () => {
    settings.themeId = elements.themeSelect.value;
    syncThemeEditor();
    saveSettings();
    applySettings();
  });
  elements.interfaceStyleSelect.addEventListener("change", () => {
    settings.interfaceStyleId = normalizeInterfaceStyleId(elements.interfaceStyleSelect.value);
    saveSettings();
    applySettings();
  });
  elements.defaultSessionBackend.addEventListener("change", () => {
    const backend = normalizeSessionMode(elements.defaultSessionBackend.value);
    settings.defaultSessionBackend = sessionBackendIsSelectable(backend) ? backend : "webshell";
    saveSettings();
    applySettings();
  });
  elements.herdrActiveBackgroundDark.addEventListener("input", () => {
    settings.herdrActiveBackgroundDark = normalizeHexColorInput(
      elements.herdrActiveBackgroundDark.value,
      DEFAULT_SETTINGS.herdrActiveBackgroundDark,
    );
    saveSettings();
    applySettings();
  });
  elements.herdrActiveBackgroundLight.addEventListener("input", () => {
    settings.herdrActiveBackgroundLight = normalizeHexColorInput(
      elements.herdrActiveBackgroundLight.value,
      DEFAULT_SETTINGS.herdrActiveBackgroundLight,
    );
    saveSettings();
    applySettings();
  });
  elements.saveTheme.addEventListener("click", () => saveCustomTheme());
  elements.removeTheme.addEventListener("click", () => removeSelectedCustomTheme());
  elements.refreshPlugins.addEventListener("click", () => void loadPlugins());
  elements.pluginList.addEventListener("change", (event) => {
    const input = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-plugin-toggle]")
      : null;
    if (input) {
      void configurePlugin(input.dataset.pluginToggle ?? "", input.checked);
      return;
    }
    const aiSetting = event.target instanceof Element
      ? event.target.closest<HTMLInputElement | HTMLSelectElement>("[data-ai-setting]")
      : null;
    if (aiSetting) {
      const value = aiSetting instanceof HTMLInputElement && aiSetting.type === "checkbox"
        ? String(aiSetting.checked)
        : aiSetting.value;
      updateAISetting(aiSetting.dataset.aiSetting ?? "", value);
      return;
    }
  });
  elements.pluginList.addEventListener("click", (event) => {
    const aiButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-ai-action]")
      : null;
    if (!aiButton) return;
    const action = aiButton.dataset.aiAction ?? "";
    if (action === "models") {
      void fetchAIModels();
    } else if (action === "test") {
      void testAIAccess();
    }
  });
  elements.pluginToolTabs.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-plugin-tool]")
      : null;
    if (!button) return;
    activePluginToolId = button.dataset.pluginTool ?? "";
    renderPluginTools();
  });
  elements.pluginToolBody.addEventListener("input", (event) => {
    const aiInput = event.target instanceof Element
      ? event.target.closest<HTMLTextAreaElement>("#aiChatInput")
      : null;
    if (aiInput) {
      resizeAIChatInput(aiInput);
    }
  });
  elements.pluginToolBody.addEventListener("change", (event) => {
    const upload = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-file-upload]")
      : null;
    if (upload) {
      const files = Array.from(upload.files ?? []);
      if (files.length) {
        void uploadFileTransfer(files).finally(() => {
          upload.value = "";
        });
      }
      return;
    }
    const aiSetting = event.target instanceof Element
      ? event.target.closest<HTMLSelectElement>("[data-ai-chat-setting]")
      : null;
    if (aiSetting) {
      updateAISetting(aiSetting.dataset.aiChatSetting ?? "", aiSetting.value);
    }
  });
  elements.pluginToolBody.addEventListener("keydown", (event) => {
    const input = event.target instanceof Element
      ? event.target.closest<HTMLTextAreaElement>("#aiChatInput")
      : null;
    if (!input || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    void runAIChat();
  });
  elements.pluginToolBody.addEventListener("click", (event) => {
    const entryButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-entry]")
      : null;
    if (entryButton) {
      void activateFileBrowserEntry(entryButton.dataset.fileEntry ?? "", event.detail > 1);
      return;
    }
    const menuButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-menu-action]")
      : null;
    if (menuButton) {
      const path = menuButton.dataset.fileMenuPath ?? selectedFileBrowserPath;
      selectedFileBrowserPath = path;
      fileBrowserContextMenu = undefined;
      void runFileTransfer(menuButton.dataset.fileMenuAction ?? "");
      return;
    }
    const fileButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-transfer-action]")
      : null;
    if (fileButton) {
      void runFileTransfer(fileButton.dataset.fileTransferAction ?? "");
      return;
    }
    const aiSettingButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-ai-chat-setting]")
      : null;
    if (aiSettingButton) {
      updateAISetting(aiSettingButton.dataset.aiChatSetting ?? "", aiSettingButton.dataset.aiChatValue ?? "");
      return;
    }
    const aiButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-ai-action]")
      : null;
    if (!aiButton) return;
    const action = aiButton.dataset.aiAction ?? "";
    if (action === "send-chat") {
      void runAIChat();
    } else if (action === "copy-output") {
      void copyAIOutput();
    } else if (action === "copy-message") {
      void copyAIMessage(Number(aiButton.dataset.aiMessageIndex));
    } else if (action === "clear-output") {
      clearAIOutput();
    } else if (action === "new-chat") {
      newAIChatSession();
    } else if (action === "export-chat") {
      exportAIChat();
    } else if (action === "models") {
      void fetchAIModels();
    } else if (action === "test") {
      void testAIAccess();
    }
  });
  elements.pluginToolBody.addEventListener("contextmenu", (event) => {
    const entryButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-entry]")
      : null;
    if (!entryButton) return;
    event.preventDefault();
    selectedFileBrowserPath = entryButton.dataset.fileEntry ?? "";
    fileBrowserContextMenu = {
      path: selectedFileBrowserPath,
      x: event.clientX,
      y: event.clientY,
    };
    renderPluginTools();
  });
  elements.fontFamily.addEventListener("change", () => {
    settings.fontFamilyId = elements.fontFamily.value;
    saveSettings();
    applySettings({ resizeTerminals: true });
  });
  elements.tabLayout.addEventListener("change", () => {
    settings.tabLayout = elements.tabLayout.value === "vertical" ? "vertical" : "horizontal";
    saveSettings();
    applySettings();
  });
  elements.fontUpload.addEventListener("change", () => void uploadFont());
  elements.fontSize.addEventListener("input", () => {
    settings.fontSize = Number(elements.fontSize.value);
    saveSettings();
    applySettings({ resizeTerminals: true });
  });
  elements.lineHeight.addEventListener("input", () => {
    settings.lineHeight = Number(elements.lineHeight.value);
    saveSettings();
    applySettings({ resizeTerminals: true });
  });
  elements.scrollbackLimit.addEventListener("change", () => {
    settings.scrollbackLimit = Math.round(
      clampNumber(elements.scrollbackLimit.value, 1000, 100000, DEFAULT_SETTINGS.scrollbackLimit),
    );
    saveSettings();
    applySettings();
  });
  elements.outputBufferLimit.addEventListener("change", () => {
    settings.outputBufferLimit = Math.round(
      clampNumber(elements.outputBufferLimit.value, MIN_OUTPUT_BUFFER_LIMIT, MAX_OUTPUT_BUFFER_LIMIT, DEFAULT_SETTINGS.outputBufferLimit),
    );
    saveSettings();
    syncOutputBufferLimitToServer();
    applySettings();
  });
  elements.terminalBackgroundEnabled.addEventListener("change", () => {
    settings.terminalBackgroundEnabled = elements.terminalBackgroundEnabled.checked;
    saveSettings();
    applySettings();
  });
  elements.terminalBackgroundUpload.addEventListener("change", () => void uploadTerminalBackground());
  elements.removeTerminalBackground.addEventListener("click", () => void removeTerminalBackground());
  elements.terminalBackgroundOpacity.addEventListener("input", () => {
    settings.terminalBackgroundOpacity = clampNumber(
      elements.terminalBackgroundOpacity.value,
      0.05,
      0.8,
      DEFAULT_SETTINGS.terminalBackgroundOpacity,
    );
    saveSettings();
    applySettings();
  });
  elements.terminalBackgroundBlur.addEventListener("input", () => {
    settings.terminalBackgroundBlur = Math.round(
      clampNumber(elements.terminalBackgroundBlur.value, 0, 24, DEFAULT_SETTINGS.terminalBackgroundBlur),
    );
    saveSettings();
    applySettings();
  });
  elements.cursorBlink.addEventListener("change", () => {
    settings.cursorBlink = elements.cursorBlink.checked;
    saveSettings();
    applySettings();
  });
  elements.cursorShape.addEventListener("change", () => {
    settings.cursorShape = elements.cursorShape.value === "bar" || elements.cursorShape.value === "underline"
      ? elements.cursorShape.value
      : "block";
    saveSettings();
    applySettings();
  });
  elements.copyOnSelect.addEventListener("change", () => {
    settings.copyOnSelect = elements.copyOnSelect.checked;
    saveSettings();
  });
  elements.useResttyClipboard.addEventListener("change", () => {
    settings.useResttyClipboard = elements.useResttyClipboard.checked;
    saveSettings();
  });
  elements.touchSelectionMode.addEventListener("change", () => {
    settings.touchSelectionMode = elements.touchSelectionMode.value === "drag" || elements.touchSelectionMode.value === "off"
      ? elements.touchSelectionMode.value
      : "long-press";
    saveSettings();
    void remountTerminalsForTouchMode();
  });
  elements.autoRestartSessions.addEventListener("change", () => {
    settings.autoRestartSessions = elements.autoRestartSessions.checked;
    saveSettings();
    syncRestartPolicyToServer();
    if (settings.autoRestartSessions) {
      void connectRestoredPanes();
    }
  });
  elements.debugMode.addEventListener("change", () => {
    settings.debugMode = elements.debugMode.checked;
    saveSettings();
  });
}

function bindActions() {
  elements.refreshInstances.addEventListener("click", () => void loadInstances());
  elements.newTabButton.addEventListener("click", (event) => {
    event.stopPropagation();
    if (selectableSessionBackends().length <= 1) {
      void createSelectedTab();
      return;
    }
    toggleNewTabMenu();
  });
  elements.newTabMenu.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-new-tab-backend]")
      : null;
    if (!button) return;
    closeNewTabMenu();
    void createSelectedTab(normalizeSessionMode(button.dataset.newTabBackend));
  });
  elements.emptyNewTab.addEventListener("click", () => void createSelectedTab());
  elements.herdrRefresh.addEventListener("click", () => void refreshHerdrState(selectedSelector));
  elements.herdrNewWorkspace.addEventListener("click", () => {
    void runHerdrAction("create_workspace");
  });
  elements.herdrWorkspaceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    void toggleHerdrWorkspaceMenu();
  });
  elements.herdrWorkspaceRefresh.addEventListener("click", (event) => {
    event.stopPropagation();
    void refreshHerdrState(selectedSelector);
  });
  elements.herdrWorkspaceMenuList.addEventListener("click", (event) => {
    const closeButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-close-workspace]")
      : null;
    if (closeButton) {
      event.preventDefault();
      event.stopPropagation();
      void runHerdrAction("close_workspace", { workspaceId: closeButton.dataset.herdrCloseWorkspace });
      return;
    }
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-workspace]")
      : null;
    if (!button) return;
    closeHerdrWorkspaceMenu();
    void restoreHerdrWorkspace(button.dataset.herdrWorkspace);
  });
  elements.herdrWorkspaceMenuList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-workspace]")
      : null;
    if (!button) return;
    event.preventDefault();
    closeHerdrWorkspaceMenu();
    void restoreHerdrWorkspace(button.dataset.herdrWorkspace);
  });
  elements.herdrNewTab.addEventListener("click", () => {
    const workspaceId = focusedHerdrWorkspace()?.workspace_id;
    void runHerdrAction("create_tab", { workspaceId });
  });
  elements.herdrWorkspaceList.addEventListener("click", (event) => {
    const closeButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-close-workspace]")
      : null;
    if (closeButton) {
      event.preventDefault();
      event.stopPropagation();
      void runHerdrAction("close_workspace", { workspaceId: closeButton.dataset.herdrCloseWorkspace });
      return;
    }
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-workspace]")
      : null;
    if (!button) return;
    void runHerdrAction("focus_workspace", { workspaceId: button.dataset.herdrWorkspace });
  });
  elements.herdrWorkspaceList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-workspace]")
      : null;
    if (!button) return;
    event.preventDefault();
    void runHerdrAction("focus_workspace", { workspaceId: button.dataset.herdrWorkspace });
  });
  elements.herdrTabList.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-tab]")
      : null;
    if (!button) return;
    void runHerdrAction("focus_tab", { tabId: button.dataset.herdrTab });
  });
  elements.herdrTabList.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-herdr-tab]")
      : null;
    if (!button) return;
    event.preventDefault();
    void runHerdrAction("focus_tab", { tabId: button.dataset.herdrTab });
  });
  elements.removeFont.addEventListener("click", () => void removeSelectedFont());
  elements.fitTerminal.addEventListener("click", () => void toggleFullscreen());
  elements.shortcutHelpButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleShortcutHelp();
  });
  elements.shortcutHelpClose.addEventListener("click", () => closeShortcutHelp());
  elements.shortcutHelp.addEventListener("click", (event) => {
    if (event.target === elements.shortcutHelp) {
      closeShortcutHelp();
    }
  });
  elements.pluginsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    togglePluginSidebar();
  });
  elements.openPluginsItem.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSettingsMenu();
    openPluginSidebar();
  });
  elements.openShortcutHelpItem.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSettingsMenu();
    if (elements.shortcutHelp.hidden) {
      toggleShortcutHelp();
    }
  });
  elements.fitTerminalItem.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSettingsMenu();
    void toggleFullscreen();
  });
  elements.closePluginSidebar.addEventListener("click", () => closePluginSidebar());
  elements.homeButton.addEventListener("click", () => void navigateLightOSHome());
  elements.settingsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleSettingsMenu();
  });
  elements.openSettingsItem.addEventListener("click", () => openSettings());
  elements.closeSettings.addEventListener("click", () => closeSettings());
  elements.settingsPage.addEventListener("click", (event) => {
    if (event.target === elements.settingsPage) {
      closeSettings();
    }
  });
  bindSettingsTabs();
  bindLifecycleEvents();
  bindMobileShortcuts();
  document.addEventListener("keydown", handleTerminalInterruptCapture, true);
  document.addEventListener("keydown", handleTerminalClipboardCapture, true);
  document.addEventListener("paste", handleTerminalPasteEvent, true);
  elements.instanceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleInstanceMenu();
  });
  elements.terminalStage.addEventListener("pointerdown", (event) => {
    if (!shouldFocusTerminalFromPointer(event)) return;
    focusActivePaneCanvas();
    requestAnimationFrame(() => focusActivePaneCanvas());
  });
  document.addEventListener("click", (event) => {
    if (event.target instanceof Node && !elements.instanceSwitcher.contains(event.target)) {
      closeInstanceMenu();
    }
    if (event.target instanceof Node && !elements.settingsMenu.contains(event.target) && event.target !== elements.settingsButton) {
      closeSettingsMenu();
    }
    if (event.target instanceof Node && !elements.newTabShell.contains(event.target)) {
      closeNewTabMenu();
    }
    if (event.target instanceof Node && !elements.herdrWorkspaceSwitcher.contains(event.target)) {
      closeHerdrWorkspaceMenu();
    }
    if (event.target instanceof Node && !elements.shortcutHelp.contains(event.target) && event.target !== elements.shortcutHelpButton) {
      closeShortcutHelp();
    }
    if (event.target instanceof Node && !elements.paneMenu.contains(event.target)) {
      closePaneMenu();
    }
    if (
      fileBrowserContextMenu
      && event.target instanceof Element
      && !event.target.closest(".file-browser-context-menu")
    ) {
      fileBrowserContextMenu = undefined;
      renderPluginTools();
    }
  });
  elements.paneMenu.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-pane-action]") : null;
    if (!button) return;
    void runPaneMenuAction(button.dataset.paneAction ?? "");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeInstanceMenu();
      closeSettingsMenu();
      closeNewTabMenu();
      closeHerdrWorkspaceMenu();
      closeShortcutHelp();
      closePaneMenu();
      fileBrowserContextMenu = undefined;
      closeSettings();
      closePluginSidebar();
      renderPluginTools();
      return;
    }
    if (handleFontZoomShortcut(event)) {
      return;
    }
    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) {
      return;
    }
    if (event.code === "KeyT") {
      event.preventDefault();
      void createSelectedTab();
    } else if (event.code === "KeyW") {
      event.preventDefault();
      closeActiveTab();
    } else if (event.code === "Comma") {
      event.preventDefault();
      openSettings();
    } else if (event.code === "ArrowUp") {
      event.preventDefault();
      void splitActivePane("up");
    } else if (event.code === "ArrowDown") {
      event.preventDefault();
      void splitActivePane("down");
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      void splitActivePane("left");
    } else if (event.code === "ArrowRight") {
      event.preventDefault();
      void splitActivePane("right");
    }
  });
}

function bindLifecycleEvents() {
  window.addEventListener("online", () => {
    void connectRestoredPanes();
    void refreshSessionBackends(selectedSelector);
    void refreshHerdrState(selectedSelector);
  });
  window.addEventListener("popstate", () => {
    const nextParams = new URLSearchParams(window.location.search);
    const nextSelector = normalizeSelector(nextParams.get("name") ?? "");
    const nextTabId = normalizeSelector(nextParams.get("tab") ?? "");
    selectedSelectorExplicit = nextParams.has("name") && Boolean(nextSelector);
    if (nextSelector === selectedSelector) {
      if (nextTabId && tabs.some((tab) => tab.id === nextTabId)) {
        activateTab(nextTabId, { updateLocation: false });
      }
      return;
    }
    setSelectedSelector(nextSelector, { updateLocation: false });
    reconcileSelectedInstance();
    renderInstances();
    if (selectedSelector) {
      void loadWorkspace(selectedSelector);
    }
  });
  window.addEventListener("focus", () => {
    handleViewportChange();
    void connectRestoredPanes();
    void refreshSessionBackends(selectedSelector);
    void refreshHerdrState(selectedSelector);
  });
  window.addEventListener("resize", handleViewportChange);
  window.addEventListener("orientationchange", handleViewportChange);
  window.visualViewport?.addEventListener("resize", handleViewportChange);
  window.visualViewport?.addEventListener("scroll", handleViewportChange);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    handleViewportChange();
    void connectRestoredPanes();
    void refreshSessionBackends(selectedSelector);
    void refreshHerdrState(selectedSelector);
  });
}

function updateViewportMetrics() {
  const viewport = window.visualViewport;
  const width = Math.max(1, Math.floor(viewport?.width ?? window.innerWidth));
  const height = Math.max(1, Math.floor(viewport?.height ?? window.innerHeight));
  const offsetTop = Math.max(0, Math.floor(viewport?.offsetTop ?? 0));
  const offsetLeft = Math.max(0, Math.floor(viewport?.offsetLeft ?? 0));
  const keyboardInset = viewport
    ? Math.max(0, Math.floor((window.innerHeight || 0) - viewport.height - viewport.offsetTop))
    : 0;
  const style = document.documentElement.style;
  style.setProperty("--app-viewport-width", `${width}px`);
  style.setProperty("--app-viewport-height", `${height}px`);
  style.setProperty("--app-viewport-offset-top", `${offsetTop}px`);
  style.setProperty("--app-viewport-offset-left", `${offsetLeft}px`);
  style.setProperty("--app-keyboard-inset-bottom", `${keyboardInset}px`);
  const mobileControls = shouldUseMobileControls(width);
  document.body.classList.toggle("mobile-keyboard-visible", keyboardInset > MOBILE_KEYBOARD_INSET_THRESHOLD_PX);
  document.body.classList.toggle("mobile-controls-enabled", mobileControls);
  document.body.classList.toggle("desktop-controls-enabled", !mobileControls && shouldUseDesktopControls(width));
}

function handleViewportChange() {
  updateViewportMetrics();
  scheduleTerminalSizeRefresh();
}

function shouldUseMobileControls(viewportWidth = Math.max(1, window.innerWidth || 0)): boolean {
  const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Harmony|HUAWEI|Miui/i.test(navigator.userAgent);
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const screenWidth = Math.max(0, Math.floor(window.screen?.width || 0));
  const screenHeight = Math.max(0, Math.floor(window.screen?.height || 0));
  const compactScreen = screenWidth > 0
    && screenHeight > 0
    && Math.min(screenWidth, screenHeight) <= 820;
  return viewportWidth <= 760
    || compactScreen
    || mobileUA
    || coarsePointer
    || (navigator.maxTouchPoints > 0 && viewportWidth <= 1180);
}

function shouldUseDesktopControls(viewportWidth = Math.max(1, window.innerWidth || 0)): boolean {
  return viewportWidth > 1180
    && navigator.maxTouchPoints === 0
    && window.matchMedia("(hover: hover) and (pointer: fine)").matches
    && !/Android|iPhone|iPad|iPod|Mobile|Harmony|HUAWEI|Miui/i.test(navigator.userAgent);
}

function bindMobileShortcuts() {
  elements.mobileShortcuts.addEventListener("pointerdown", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-mobile-shortcut]")
      : null;
    if (!button || button.dataset.mobileRepeat === "true") return;
    event.preventDefault();
    void runMobileShortcut(button.dataset.mobileShortcut ?? "");
  });

  elements.mobileShortcuts.addEventListener("click", (event) => {
    if (
      event.target instanceof Element
      && event.target.closest("[data-mobile-shortcut], [data-mobile-action], [data-mobile-chord], [data-mobile-page]")
    ) {
      event.preventDefault();
    }
  });

  elements.mobileShortcuts.addEventListener("pointerdown", (event) => {
    const chordButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-mobile-chord]")
      : null;
    if (chordButton) {
      event.preventDefault();
      runMobileChord(chordButton.dataset.mobileChord ?? "");
      return;
    }
    const actionButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-mobile-action]")
      : null;
    if (!actionButton) return;
    event.preventDefault();
    void runMobileAction(actionButton.dataset.mobileAction ?? "");
  });

  elements.mobileShortcuts.addEventListener("pointerdown", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-mobile-page]")
      : null;
    if (!button) return;
    event.preventDefault();
    activateMobileKeyboardPage(button.dataset.mobilePage ?? "");
  });

  elements.mobileShortcuts.querySelectorAll<HTMLButtonElement>("[data-mobile-repeat='true']").forEach((button) => {
    button.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      button.setPointerCapture?.(event.pointerId);
      const shortcut = button.dataset.mobileShortcut ?? "";
      void runMobileShortcut(shortcut, { keepModifiers: true });
      window.clearTimeout(mobileRepeatTimer);
      window.clearInterval(mobileRepeatInterval);
      mobileRepeatTimer = window.setTimeout(() => {
        mobileRepeatInterval = window.setInterval(() => void runMobileShortcut(shortcut, { keepModifiers: true }), 86);
      }, 360);
    });
    const stopRepeat = () => {
      stopMobileShortcutRepeat();
      clearMobileSticky();
    };
    button.addEventListener("pointerup", stopRepeat);
    button.addEventListener("pointercancel", stopRepeat);
    button.addEventListener("lostpointercapture", stopRepeat);
  });
  updateMobileShortcutState();
}

function activateMobileKeyboardPage(page: string) {
  if (!page) return;
  elements.mobileShortcuts.querySelectorAll<HTMLButtonElement>("[data-mobile-page]").forEach((button) => {
    const active = button.dataset.mobilePage === page;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  elements.mobileShortcuts.querySelectorAll<HTMLElement>("[data-mobile-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.mobilePanel !== page;
  });
}

function bindSettingsTabs() {
  elements.settingsTabs.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-settings-tab]")
      : null;
    if (button) activateSettingsTab(button.dataset.settingsTab ?? "");
  });
  elements.fontTabs.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-font-tab]")
      : null;
    if (button) activateFontTab(button.dataset.fontTab ?? "");
  });
}

function activateSettingsTab(tabId: string) {
  if (!tabId) return;
  elements.settingsTabs.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === tabId;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.settingsPage.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tabId;
  });
  if (tabId === "plugins" && !pluginsLoaded && !pluginsLoading) {
    void loadPlugins();
  }
}

function activateFontTab(tabId: string) {
  if (!tabId) return;
  elements.fontTabs.querySelectorAll<HTMLButtonElement>("[data-font-tab]").forEach((button) => {
    const active = button.dataset.fontTab === tabId;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.settingsPage.querySelectorAll<HTMLElement>("[data-font-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.fontPanel !== tabId;
  });
}

function stopMobileShortcutRepeat() {
  window.clearTimeout(mobileRepeatTimer);
  window.clearInterval(mobileRepeatInterval);
  mobileRepeatTimer = undefined;
  mobileRepeatInterval = undefined;
}

async function runMobileShortcut(shortcut: string, options: { keepModifiers?: boolean } = {}) {
  if (isMobileModifierShortcut(shortcut)) {
    mobileSticky[shortcut] = !mobileSticky[shortcut];
    updateMobileShortcutState();
    focusActivePaneSystemKeyboard();
    return;
  }

  if (shortcut === "paste") {
    await pasteIntoPane(activePane(), false);
    clearMobileSticky();
    focusAfterMobileShortcut();
    return;
  }

  const data = encodeMobileShortcutKeyInput(shortcut, mobileSticky);
  if (data) {
    sendActivePaneKeyInput(data);
  }
  if (!options.keepModifiers) {
    clearMobileSticky();
  }
  focusAfterMobileShortcut();
}

function isMobileModifierShortcut(shortcut: string): shortcut is keyof typeof mobileSticky {
  return shortcut === "ctrl" || shortcut === "alt" || shortcut === "shift";
}

function runMobileChord(chord: string) {
  const data = mobileChordInput(chord);
  if (data) {
    sendActivePaneKeyInput(data);
  }
  clearMobileSticky();
  focusAfterMobileShortcut();
}

async function runMobileAction(action: string) {
  if (action === "previous-tab") {
    activateAdjacentTab(-1);
  } else if (action === "next-tab") {
    activateAdjacentTab(1);
  } else if (action === "new-tab") {
    await createSelectedTab();
  } else if (action === "close-tab") {
    closeActiveTab();
  } else if (action === "previous-pane") {
    activateAdjacentPane(-1);
  } else if (action === "next-pane" || action === "swap-pane") {
    activateAdjacentPane(1);
  } else if (action === "split-right") {
    await splitActivePane("right");
  } else if (action === "split-down") {
    await splitActivePane("down");
  } else if (action === "copy-selection") {
    await copySelection(true);
  } else if (action === "paste-clipboard") {
    await pasteIntoPane(activePane(), true);
  } else if (action === "font-larger") {
    setTerminalFontSize(settings.fontSize + 1);
  } else if (action === "font-smaller") {
    setTerminalFontSize(settings.fontSize - 1);
  } else if (action === "pane-menu") {
    openActivePaneMenu();
  }
  clearMobileSticky();
  if (action !== "pane-menu") {
    focusAfterMobileShortcut();
  }
}

function mobileChordInput(chord: string): string | undefined {
  if (chord === "ctrl-c") return "\x03";
  if (chord === "ctrl-e") return "\x05";
  if (chord === "shift-tab") return "\x1b[Z";
  return undefined;
}

function hasMobileStickyModifiers(): boolean {
  return mobileSticky.ctrl || mobileSticky.alt || mobileSticky.shift;
}

function transformMobileStickyInput(text: string, source: string): string | undefined {
  if (!hasMobileStickyModifiers() || source === "pty" || source === "program") return undefined;
  const encoded = encodeModifiedTextInput(text, mobileSticky);
  if (!encoded) return undefined;
  clearMobileSticky();
  return encoded;
}

function clearMobileSticky() {
  mobileSticky.ctrl = false;
  mobileSticky.alt = false;
  mobileSticky.shift = false;
  updateMobileShortcutState();
}

function updateMobileShortcutState() {
  elements.mobileShortcuts.querySelectorAll<HTMLButtonElement>("[data-mobile-modifier]").forEach((button) => {
    const modifier = button.dataset.mobileModifier;
    const active = modifier === "ctrl" || modifier === "alt" || modifier === "shift" ? mobileSticky[modifier] : false;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function navigateLightOSHome() {
  closeInstanceMenu();
  closePaneMenu();
  closeSettingsMenu();
  elements.homeButton.disabled = true;
  setGlobalStatus(tr("status.lightosHomeLoading"));
  try {
    const target = await resolveLightOSHomeUrl();
    window.location.assign(target);
  } catch (error) {
    elements.homeButton.disabled = false;
    setGlobalStatus(tr("status.lightosHomeFailed", { message: errorMessage(error) }), "error");
  }
}

async function resolveLightOSHomeUrl(): Promise<string> {
  const response = await fetch(new URL("./api/lightos-admin-info", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.ok) {
    const info = await response.json() as { base_url?: string };
    const baseUrl = info.base_url?.trim();
    if (baseUrl) return buildLightOSHomeUrl(baseUrl);
  }

  const referrerUrl = referrerHomeUrl();
  if (referrerUrl) return referrerUrl;
  throw new Error(response.ok ? "LightOS admin base_url is empty" : await response.text());
}

function buildLightOSHomeUrl(value: string): string {
  const target = new URL(value, window.location.href);
  target.searchParams.set("view", "home");
  return target.toString();
}

function referrerHomeUrl(): string {
  try {
    if (!document.referrer) return "";
    const referrer = new URL(document.referrer);
    if (referrer.origin === window.location.origin) return "";
    referrer.pathname = "/";
    referrer.search = "";
    referrer.hash = "";
    return buildLightOSHomeUrl(referrer.toString());
  } catch {
    return "";
  }
}

function openSettings() {
  elements.settingsPage.hidden = false;
  elements.webshell.classList.add("settings-open");
  setAppBackgroundInert(true);
  closeInstanceMenu();
  closeSettingsMenu();
  if (!pluginsLoaded && !pluginsLoading) {
    void loadPlugins();
  }
  requestAnimationFrame(() => elements.closeSettings.focus());
}

function closeSettings() {
  elements.settingsPage.hidden = true;
  elements.webshell.classList.remove("settings-open");
  setAppBackgroundInert(false);
  activePane()?.term?.focus();
}

function setAppBackgroundInert(inert: boolean) {
  for (const element of [elements.topbar, elements.terminalStage]) {
    if ("inert" in element) {
      element.inert = inert;
    }
    element.setAttribute("aria-hidden", String(inert));
  }
}

function toggleSettingsMenu() {
  const open = elements.settingsMenu.hidden;
  closeShortcutHelp();
  elements.settingsMenu.hidden = !open;
  elements.settingsButton.setAttribute("aria-expanded", String(open));
}

function closeSettingsMenu() {
  elements.settingsMenu.hidden = true;
  elements.settingsButton.setAttribute("aria-expanded", "false");
}

function togglePluginSidebar() {
  if (elements.pluginSidebar.hidden) {
    openPluginSidebar();
  } else {
    closePluginSidebar();
  }
}

function openPluginSidebar() {
  closeSettingsMenu();
  closeShortcutHelp();
  closeInstanceMenu();
  closePaneMenu();
  closeSettings();
  elements.pluginSidebar.hidden = false;
  elements.webshell.classList.add("plugins-open");
  elements.pluginsButton.setAttribute("aria-expanded", "true");
  if (!pluginsLoaded && !pluginsLoading) {
    void loadPlugins();
  } else {
    renderPluginTools();
  }
}

function closePluginSidebar() {
  elements.pluginSidebar.hidden = true;
  elements.webshell.classList.remove("plugins-open");
  elements.pluginsButton.setAttribute("aria-expanded", "false");
  activePane()?.term?.focus();
}

function toggleShortcutHelp() {
  const open = elements.shortcutHelp.hidden;
  closeSettingsMenu();
  closeInstanceMenu();
  closePaneMenu();
  elements.shortcutHelp.hidden = !open;
  elements.shortcutHelpButton.setAttribute("aria-expanded", String(open));
  if (open) {
    requestAnimationFrame(() => elements.shortcutHelpClose.focus());
  }
}

function closeShortcutHelp() {
  elements.shortcutHelp.hidden = true;
  elements.shortcutHelpButton.setAttribute("aria-expanded", "false");
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await elements.webshell.requestFullscreen();
    }
  } catch {
    activePane()?.term?.focus();
  }
}

function toggleInstanceMenu() {
  const open = elements.instanceMenu.hidden;
  closeSettingsMenu();
  elements.instanceMenu.hidden = !open;
  elements.instanceSwitcher.classList.toggle("is-open", open);
  elements.instanceButton.setAttribute("aria-expanded", String(open));
}

function closeInstanceMenu() {
  elements.instanceMenu.hidden = true;
  elements.instanceSwitcher.classList.remove("is-open");
  elements.instanceButton.setAttribute("aria-expanded", "false");
}

function openPaneMenu(clientX: number, clientY: number, paneId: string) {
  contextPaneId = paneId;
  updatePaneMenuForPane(paneId);
  elements.paneMenu.hidden = false;
  elements.paneMenu.style.left = "0";
  elements.paneMenu.style.top = "0";
  updateIcons();
  requestAnimationFrame(() => {
    const margin = 8;
    const rect = elements.paneMenu.getBoundingClientRect();
    const left = Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin));
    const top = Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin));
    elements.paneMenu.style.left = `${left}px`;
    elements.paneMenu.style.top = `${top}px`;
  });
}

function openActivePaneMenu() {
  const pane = activePane();
  if (!pane) return;
  const rect = pane.mount.getBoundingClientRect();
  openPaneMenu(
    rect.left + rect.width / 2,
    Math.min(rect.bottom - 12, window.innerHeight - 12),
    pane.id,
  );
}

function updatePaneMenuForPane(paneId: string) {
  const pane = findPaneById(paneId);
  const tab = pane ? tabForPane(pane) : undefined;
  elements.paneMenu.querySelectorAll<HTMLButtonElement>("[data-pane-action]").forEach((button) => {
    button.hidden = !paneMenuActionSupported(button.dataset.paneAction ?? "", pane, tab);
  });
}

function paneMenuActionSupported(
  action: string,
  pane: TerminalPane | undefined,
  tab: TerminalTab | undefined,
): boolean {
  if (!pane) return false;
  if (pane.sessionBackend === "herdr" || pane.sessionBackend === "zellij") {
    return action === "split-right"
      || action === "split-down"
      || action === "copy-selection"
      || action === "paste-clipboard"
      || action === "close-active-session";
  }
  if (action === "promote-session-to-tab") {
    return Boolean(tab && visiblePanes(tab).length > 1);
  }
  return action === "split-up"
    || action === "split-down"
    || action === "split-left"
    || action === "split-right"
    || action === "copy-selection"
    || action === "paste-clipboard"
    || action === "close-active-session";
}

function closePaneMenu() {
  elements.paneMenu.hidden = true;
  elements.paneMenu.style.left = "";
  elements.paneMenu.style.top = "";
  contextPaneId = undefined;
}

async function runPaneMenuAction(action: string) {
  const pane = contextPaneId ? findPaneById(contextPaneId) : activePane();
  const tab = pane ? tabForPane(pane) : undefined;
  closePaneMenu();
  if (tab && pane) {
    activatePane(tab.id, pane.id);
  }
  if (pane?.sessionBackend === "herdr") {
    await runHerdrPaneMenuAction(action, pane);
    return;
  }
  if (pane?.sessionBackend === "zellij") {
    await runZellijPaneMenuAction(action, pane);
    return;
  }
  if (action === "split-up") {
    await splitActivePane("up");
  } else if (action === "split-down") {
    await splitActivePane("down");
  } else if (action === "split-left") {
    await splitActivePane("left");
  } else if (action === "split-right") {
    await splitActivePane("right");
  } else if (action === "copy-selection") {
    await copySelection(true, pane);
  } else if (action === "paste-clipboard") {
    await pasteIntoPane(pane, true);
  } else if (action === "promote-session-to-tab" && tab && pane) {
    await promoteSessionToNewTab(tab, pane);
  } else if (action === "close-active-session" && tab && pane) {
    await closeActiveSession(tab, pane);
  }
}

async function runHerdrPaneMenuAction(action: string, pane: TerminalPane) {
  try {
    const placement = splitPlacementForPaneAction(action);
    if (placement) {
      await splitHerdrPane(pane, placement);
    } else if (action === "copy-selection") {
      await copySelection(true, pane);
    } else if (action === "paste-clipboard") {
      await pasteIntoHerdrPane(pane, true);
    } else if (action === "close-active-session") {
      await closeHerdrPane(pane);
    }
  } catch (error) {
    setGlobalStatus(tr("status.herdrActionFailed", { message: errorMessage(error) }), "error");
  }
}

async function runZellijPaneMenuAction(action: string, pane: TerminalPane) {
  const placement = splitPlacementForPaneAction(action);
  if (placement) {
    splitZellijPane(pane, placement);
  } else if (action === "copy-selection") {
    await copySelection(true, pane);
  } else if (action === "paste-clipboard") {
    await pasteIntoPane(pane, true);
  } else if (action === "close-active-session") {
    closeZellijPane(pane);
  }
}

function splitPlacementForPaneAction(action: string): SplitPlacement | undefined {
  if (action === "split-up") return "up";
  if (action === "split-down") return "down";
  if (action === "split-left") return "left";
  if (action === "split-right") return "right";
  return undefined;
}

async function splitHerdrPane(pane: TerminalPane, placement: SplitPlacement): Promise<boolean> {
  const direction = HERDR_SPLIT_DIRECTIONS[placement];
  if (!direction) {
    setBackendActionUnavailable(pane);
    return false;
  }
  const selector = await ensureHerdrSocketReady(pane);
  const paneId = await currentHerdrPaneId(selector);
  await runHerdrSocketRequest("pane.split", {
    target_pane_id: paneId,
    direction,
    focus: true,
  }, {
    selector,
    id: `lazycat-webshell:pane-split-${direction}`,
    mirrorNotification: false,
  });
  await refreshHerdrState(selector);
  await syncHerdrEventBridge({ force: true });
  activePane()?.term?.focus();
  return true;
}

async function closeHerdrPane(pane: TerminalPane): Promise<boolean> {
  const selector = await ensureHerdrSocketReady(pane);
  const paneId = await currentHerdrPaneId(selector);
  await runHerdrSocketRequest("pane.close", { pane_id: paneId }, {
    selector,
    id: "lazycat-webshell:pane-close",
    mirrorNotification: false,
  });
  await refreshHerdrState(selector);
  await syncHerdrEventBridge({ force: true });
  activePane()?.term?.focus();
  return true;
}

async function pasteIntoHerdrPane(pane: TerminalPane, report: boolean): Promise<boolean> {
  const imagePayload = await readClipboardImagePayload();
  if (imagePayload) {
    return pasteClipboardImageIntoHerdrPane(pane, imagePayload, report);
  }

  try {
    const text = await navigator.clipboard?.readText?.() ?? "";
    if (!text) return false;
    return pasteTextIntoHerdrPane(pane, text, report);
  } catch (error) {
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function pasteTextIntoHerdrPane(pane: TerminalPane, text: string, report: boolean): Promise<boolean> {
  if (!text) return false;
  try {
    const selector = await ensureHerdrSocketReady(pane);
    const paneId = await currentHerdrPaneId(selector);
    await runHerdrSocketRequest("pane.send_text", { pane_id: paneId, text }, {
      selector,
      id: "lazycat-webshell:pane-paste",
      mirrorNotification: false,
    });
    pane.term?.focus();
    return true;
  } catch (error) {
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function pasteClipboardImageIntoHerdrPane(
  pane: TerminalPane,
  payload: ClipboardImagePayload,
  report: boolean,
): Promise<boolean> {
  if (payload.data.byteLength <= 0 || payload.data.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return false;
  try {
    const selector = await ensureHerdrSocketReady(pane);
    const paneId = await currentHerdrPaneId(selector);
    const path = await stageClipboardImage(selector, payload);
    if (!path) return false;
    await runHerdrSocketRequest("pane.send_text", { pane_id: paneId, text: path }, {
      selector,
      id: "lazycat-webshell:pane-paste-image",
      mirrorNotification: false,
    });
    pane.term?.focus();
    return true;
  } catch (error) {
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function ensureHerdrSocketReady(pane: TerminalPane): Promise<string> {
  const selector = normalizeSelector(pane.selector || selectedSelector);
  if (!selector) throw new Error(tr("status.selectRunningInstance"));
  const stateMatches = herdrState?.available && normalizeSelector(herdrState.selector) === selector;
  if (stateMatches || await refreshHerdrState(selector)) return selector;
  throw new Error(tr("status.herdrUnavailable"));
}

async function currentHerdrPaneId(selector: string): Promise<string> {
  const current = await runHerdrSocketRequest("pane.current", {}, {
    selector,
    id: "lazycat-webshell:pane-current",
    mirrorNotification: false,
  });
  const currentPane = recordField(current.result, "pane");
  const currentPaneId = stringField(currentPane, "pane_id");
  if (currentPaneId) return currentPaneId;

  const workspaceId = herdrState?.workspaces.find((workspace) => workspace.focused)?.workspace_id;
  const list = await runHerdrSocketRequest("pane.list", workspaceId ? { workspace_id: workspaceId } : {}, {
    selector,
    id: "lazycat-webshell:pane-list-current",
    mirrorNotification: false,
  });
  const panes = Array.isArray(list.result?.panes) ? list.result.panes : [];
  const records = panes
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const focusedPane = records.find((item) => boolField(item, "focused"));
  const fallbackPaneId = stringField(focusedPane ?? records[0], "pane_id");
  if (fallbackPaneId) return fallbackPaneId;
  throw new Error("Herdr pane not found");
}

function splitZellijPane(pane: TerminalPane, placement: SplitPlacement): boolean {
  const key = ZELLIJ_SPLIT_KEYS[placement];
  if (!key) {
    setBackendActionUnavailable(pane);
    return false;
  }
  return sendZellijPaneModeKey(pane, key);
}

function closeZellijPane(pane: TerminalPane): boolean {
  return sendZellijPaneModeKey(pane, "x");
}

function sendZellijPaneModeKey(pane: TerminalPane, key: string): boolean {
  if (sendPaneInput(pane, `${ZELLIJ_PANE_MODE_PREFIX}${key}`)) {
    pane.term?.focus();
    return true;
  }
  setBackendActionFailed(pane, "input unavailable");
  return false;
}

function setBackendActionUnavailable(pane: TerminalPane) {
  setGlobalStatus(
    tr("status.backendActionUnavailable", {
      backend: sessionBackendLabel(pane.sessionBackend, pane.sessionBackend),
    }),
    "neutral",
  );
}

function setBackendActionFailed(pane: TerminalPane, message: string) {
  setGlobalStatus(
    tr("status.backendActionFailed", {
      backend: sessionBackendLabel(pane.sessionBackend, pane.sessionBackend),
      message,
    }),
    "error",
  );
}

function handleFontZoomShortcut(event: KeyboardEvent): boolean {
  if (!elements.settingsPage.hidden) return false;
  if (isEditableTarget(event.target)) return false;
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return false;
  if (event.code === "Equal" || event.code === "NumpadAdd") {
    event.preventDefault();
    setTerminalFontSize(settings.fontSize + 1);
    return true;
  }
  if (event.code === "Minus" || event.code === "NumpadSubtract") {
    event.preventDefault();
    setTerminalFontSize(settings.fontSize - 1);
    return true;
  }
  if (event.code === "Digit0" || event.code === "Numpad0") {
    event.preventDefault();
    setTerminalFontSize(DEFAULT_SETTINGS.fontSize);
    return true;
  }
  return false;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

function setTerminalFontSize(value: number) {
  const next = Math.round(clampNumber(value, 11, 22, DEFAULT_SETTINGS.fontSize));
  if (next === settings.fontSize) return;
  settings.fontSize = next;
  saveSettings();
  applySettings({ resizeTerminals: true });
}

function applySettings(options: { resizeTerminals?: boolean } = {}) {
  const theme = currentTheme();
  const font = currentFont();
  const resttyTheme = resttyThemeFor(theme);
  applyI18n();
  applyThemeVariables(elements.webshell, resttyTheme);
  applyThemeVariables(elements.terminalStage, resttyTheme);
  elements.localeSelect.value = settings.locale;
  elements.interfaceStyleSelect.value = settings.interfaceStyleId;
  renderThemeOptions();
  elements.themeSelect.value = theme.id;
  syncThemeEditor();
  elements.fontFamily.value = font.id;
  elements.fontPreview.style.fontFamily = font.family;
  elements.fontPreview.style.fontSize = `${settings.fontSize}px`;
  elements.tabLayout.value = settings.tabLayout;
  elements.webshell.dataset.tabLayout = settings.tabLayout;
  elements.webshell.dataset.interfaceStyle = settings.interfaceStyleId;
  elements.webshell.dataset.interfaceTone = isLightInterfaceStyle(settings.interfaceStyleId) ? "light" : "dark";
  elements.webshell.style.setProperty("--herdr-active-bg", currentHerdrActiveBackground());
  elements.webshell.style.setProperty("--herdr-active-fg", isLightInterfaceStyle(settings.interfaceStyleId) ? "#17231d" : "#f4fff8");
  elements.removeFont.disabled = !font.custom;
  settings.themeId = theme.id;
  settings.fontFamilyId = font.id;
  elements.fontSize.value = String(settings.fontSize);
  elements.fontSizeValue.textContent = `${settings.fontSize}px`;
  elements.lineHeight.value = String(settings.lineHeight);
  elements.lineHeightValue.textContent = settings.lineHeight.toFixed(2);
  elements.scrollbackLimit.value = String(settings.scrollbackLimit);
  elements.outputBufferLimit.value = String(settings.outputBufferLimit);
  elements.terminalBackgroundEnabled.checked = settings.terminalBackgroundEnabled;
  elements.terminalBackgroundEnabled.disabled = !settings.terminalBackgroundUrl;
  elements.removeTerminalBackground.disabled = !settings.terminalBackgroundUrl;
  elements.terminalBackgroundOpacity.value = String(settings.terminalBackgroundOpacity);
  elements.terminalBackgroundOpacityValue.textContent = `${Math.round(settings.terminalBackgroundOpacity * 100)}%`;
  elements.terminalBackgroundBlur.value = String(settings.terminalBackgroundBlur);
  elements.terminalBackgroundBlurValue.textContent = `${settings.terminalBackgroundBlur}px`;
  elements.cursorBlink.checked = settings.cursorBlink;
  elements.cursorShape.value = settings.cursorShape;
  elements.copyOnSelect.checked = settings.copyOnSelect;
  elements.useResttyClipboard.checked = settings.useResttyClipboard;
  elements.touchSelectionMode.value = settings.touchSelectionMode;
  elements.autoRestartSessions.checked = settings.autoRestartSessions;
  elements.debugMode.checked = settings.debugMode;
  updateSessionBackendSettings();
  renderPlugins();

  for (const pane of allPanes()) {
    applyTerminalAppearance(pane, resttyTheme);
    if (options.resizeTerminals) {
      pane.term?.restty?.setFontSize(settings.fontSize);
      pane.term?.restty?.updateSize(true);
    }
  }
  renderTabs();
  updateActiveDetails();
}

function currentTheme(): TerminalTheme {
  return resolveTheme(settings.themeId, settings.customThemes);
}

function normalizeInterfaceStyleId(value: string): InterfaceStyleId {
  return INTERFACE_STYLE_IDS.includes(value as InterfaceStyleId)
    ? value as InterfaceStyleId
    : DEFAULT_SETTINGS.interfaceStyleId;
}

function isLightInterfaceStyle(value: InterfaceStyleId): boolean {
  return LIGHT_INTERFACE_STYLES.has(value);
}

function currentHerdrActiveBackground(): string {
  return isLightInterfaceStyle(settings.interfaceStyleId)
    ? settings.herdrActiveBackgroundLight
    : settings.herdrActiveBackgroundDark;
}

function normalizeHexColorInput(value: string, fallback: string): string {
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : fallback;
}

function updateSessionBackendSettings() {
  const selectable = selectableSessionBackends();
  const hasOptionalBackend = selectable.some((backend) => backend.id !== "webshell");
  const hasHerdr = selectable.some((backend) => backend.id === "herdr");
  elements.sessionBackendSettings.hidden = !hasOptionalBackend;
  elements.herdrHighlightSettings.hidden = !hasHerdr;
  elements.herdrActiveBackgroundDark.value = normalizeHexColorInput(
    settings.herdrActiveBackgroundDark,
    DEFAULT_SETTINGS.herdrActiveBackgroundDark,
  );
  elements.herdrActiveBackgroundLight.value = normalizeHexColorInput(
    settings.herdrActiveBackgroundLight,
    DEFAULT_SETTINGS.herdrActiveBackgroundLight,
  );
  if (!hasOptionalBackend) {
    settings.defaultSessionBackend = "webshell";
    elements.defaultSessionBackend.innerHTML = `<option value="webshell">${escapeHtml(tr("backend.webshell"))}</option>`;
    elements.defaultSessionBackend.value = "webshell";
    renderNewTabMenu();
    updateHerdrWorkspaceEntry();
    return;
  }
  const selected = selectable.some((backend) => backend.id === settings.defaultSessionBackend)
    ? settings.defaultSessionBackend
    : "webshell";
  if (settings.defaultSessionBackend !== selected) {
    settings.defaultSessionBackend = selected;
  }
  elements.defaultSessionBackend.innerHTML = selectable
    .map((backend) => `<option value="${escapeAttr(backend.id)}">${escapeHtml(sessionBackendLabel(backend.id, backend.label))}</option>`)
    .join("");
  elements.defaultSessionBackend.value = selected;
  renderNewTabMenu();
  updateHerdrWorkspaceEntry();
}

function selectableSessionBackends(): SessionBackendInfo[] {
  const backends = sessionBackendsState?.backends ?? [{ id: "webshell" as const, label: "WebShell native", available: true }];
  return backends.filter((backend) => backend.available || backend.id === "webshell");
}

function backendInstalled(mode: SessionMode): boolean {
  return selectableSessionBackends().some((backend) => backend.id === mode);
}

function updateHerdrWorkspaceEntry() {
  const hasHerdr = backendInstalled("herdr");
  elements.herdrWorkspaceSwitcher.hidden = !hasHerdr;
  if (!hasHerdr) {
    closeHerdrWorkspaceMenu();
  }
}

function currentFont(): FontPreset {
  return [...FONT_PRESETS, ...customFonts].find((item) => item.id === settings.fontFamilyId) ?? FONT_PRESETS[0];
}

function applyThemeVariables(target: HTMLElement, resttyTheme = resttyThemeFor(currentTheme())) {
  const vars = terminalThemeCssVars(resttyTheme);
  for (const [name, value] of Object.entries(vars)) {
    target.style.setProperty(name, value);
  }
}

function applyThemeToMount(mount: HTMLElement, resttyTheme = resttyThemeFor(currentTheme())) {
  const theme = currentTheme();
  const font = currentFont();
  const themeClasses = THEMES.map((item) => item.className).filter((value): value is string => Boolean(value));
  mount.classList.remove(...themeClasses);
  if (theme.className) {
    mount.classList.add(theme.className);
  }
  applyThemeVariables(mount, resttyTheme);
  mount.classList.remove("cursor-shape-block", "cursor-shape-bar", "cursor-shape-underline");
  mount.classList.add(`cursor-shape-${settings.cursorShape}`);
  mount.classList.toggle("cursor-blink", settings.cursorBlink);
  mount.style.setProperty("--term-font-family", font.family);
  mount.style.setProperty("--term-font-size", `${settings.fontSize}px`);
  mount.style.setProperty("--term-line-height", String(settings.lineHeight));
  applyTerminalBackgroundToMount(mount);
}

function applyTerminalAppearance(pane: TerminalPane, theme = resttyThemeFor(currentTheme())) {
  applyThemeToMount(pane.mount, theme);
  const term = pane.term;
  if (!term?.restty) return;
  const hasBackground = terminalBackgroundActive();
  const renderTheme = hasBackground ? withTransparentBackground(theme) : theme;
  if (renderTheme) {
    term.restty.applyTheme(renderTheme, currentTheme().label);
  }
  const themeVars = terminalThemeCssVars(theme);
  term.restty.setPaneStyleOptions({
    splitBackground: hasBackground ? "transparent" : themeVars["--term-bg"],
    paneBackground: hasBackground ? "transparent" : themeVars["--term-bg"],
    inactivePaneOpacity: 1,
    activePaneOpacity: 1,
    opacityTransitionMs: 0,
    dividerThicknessPx: 1,
  });
  applyCursorAppearance(pane);
  term.restty.setFontSize(settings.fontSize);
  void term.restty.setFontSources(resttyFontSourcesFor(currentFont())).catch((error) => {
    setFontStatus(tr("status.fontLoadFailed", { message: errorMessage(error) }), "error");
  });
  term.restty.updateSize(true);
}

function terminalBackgroundActive(): boolean {
  return settings.terminalBackgroundEnabled && Boolean(settings.terminalBackgroundUrl);
}

function applyTerminalBackgroundToMount(mount: HTMLElement) {
  const active = terminalBackgroundActive();
  mount.classList.toggle("has-terminal-background", active);
  if (!active) {
    mount.style.removeProperty("--terminal-bg-image");
    mount.style.removeProperty("--terminal-bg-opacity");
    mount.style.removeProperty("--terminal-bg-blur");
    return;
  }
  mount.style.setProperty("--terminal-bg-image", `url(${JSON.stringify(settings.terminalBackgroundUrl)})`);
  mount.style.setProperty("--terminal-bg-opacity", String(settings.terminalBackgroundOpacity));
  mount.style.setProperty("--terminal-bg-blur", `${settings.terminalBackgroundBlur}px`);
}

function applyCursorAppearance(pane: TerminalPane) {
  pane.term?.write(cursorStyleSequence(settings.cursorShape, settings.cursorBlink));
}

function syncThemeEditor() {
  const theme = currentTheme();
  elements.removeTheme.disabled = !theme.custom;
  elements.customThemeName.value = theme.custom ? theme.label : "";
  elements.customThemeSource.value = theme.ghosttySource ?? "";
}

function saveCustomTheme() {
  const label = elements.customThemeName.value.trim();
  const source = elements.customThemeSource.value.trim().slice(0, MAX_CUSTOM_THEME_SOURCE_BYTES);
  if (!label) {
    setThemeStatus(tr("validation.themeName"), "error");
    return;
  }
  const parsed = validateGhosttyThemeSource(source);
  if (!parsed.ok) {
    setThemeStatus(tr("status.themeInvalid", { message: parsed.message }), "error");
    return;
  }
  const current = currentTheme();
  const id = current.custom ? current.id : `${CUSTOM_THEME_PREFIX}${newId()}`;
  const next = { id, label, ghosttySource: source };
  settings.customThemes = [
    ...settings.customThemes.filter((theme) => theme.id !== id),
    next,
  ];
  settings.themeId = id;
  saveSettings();
  renderOptions();
  applySettings();
  setThemeStatus(tr("status.themeSaved", { name: label }), "ok");
}

function removeSelectedCustomTheme() {
  const theme = currentTheme();
  if (!theme.custom) return;
  settings.customThemes = settings.customThemes.filter((item) => item.id !== theme.id);
  settings.themeId = DEFAULT_SETTINGS.themeId;
  saveSettings();
  renderOptions();
  applySettings();
  setThemeStatus(tr("status.themeRemoved", { name: theme.label }), "ok");
}

function validateGhosttyThemeSource(source: string): { ok: true } | { ok: false; message: string } {
  if (!source || !/(^|\n)\s*(background|foreground|palette)\s*=/.test(source)) {
    return { ok: false, message: tr("validation.themeSource") };
  }
  try {
    const theme = parseCustomGhosttyTheme(source);
    if (!theme.colors.background && !theme.colors.foreground && !theme.colors.palette.some(Boolean)) {
      return { ok: false, message: tr("validation.themeSource") };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, message: errorMessage(error) };
  }
}

function setThemeStatus(message: string, tone: Tone = "neutral") {
  elements.themeStatus.textContent = message;
  elements.themeStatus.dataset.tone = tone;
}

async function loadUploadedFonts() {
  try {
    const response = await fetch(new URL("./api/fonts", window.location.href), {
      credentials: "same-origin",
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const fonts = await response.json() as StoredFont[];
    customFonts = fonts.map(storedFontToResttyPreset).filter((font): font is FontPreset => Boolean(font));
    setFontStatus(customFonts.length ? tr("status.fontsReady", { count: customFonts.length }) : "");
  } catch (error) {
    setFontStatus(tr("status.fontLoadFailed", { message: errorMessage(error) }), "error");
  }
}

async function uploadFont() {
  const file = elements.fontUpload.files?.[0];
  elements.fontUpload.value = "";
  if (!file) return;

  try {
    validateFontFile(file);
    const url = new URL("./api/fonts", window.location.href);
    url.searchParams.set("filename", file.name);
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": file.type || mimeTypeForFont(file.name) },
      body: file,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const stored = await response.json() as StoredFont;
    const preset = storedFontToResttyPreset(stored);
    if (!preset) throw new Error(tr("status.fontRegistrationFailed"));
    customFonts = [...customFonts.filter((font) => font.id !== preset.id), preset];
    settings.fontFamilyId = preset.id;
    saveSettings();
    renderOptions();
    applySettings({ resizeTerminals: true });
    setFontStatus(tr("status.fontReady", { name: preset.label }), "ok");
  } catch (error) {
    setFontStatus(tr("status.fontUploadFailed", { message: errorMessage(error) }), "error");
  }
}

async function removeSelectedFont() {
  const font = currentFont();
  if (!font.custom) return;
  const id = font.id.replace(/^custom:/, "");
  const response = await fetch(new URL(`./api/fonts/${encodeURIComponent(id)}`, window.location.href), {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok && response.status !== 404) {
    setFontStatus(tr("status.fontDeleteFailed", { message: await response.text() }), "error");
    return;
  }
  customFonts = customFonts.filter((item) => item.id !== font.id);
  settings.fontFamilyId = DEFAULT_SETTINGS.fontFamilyId;
  saveSettings();
  renderOptions();
  applySettings({ resizeTerminals: true });
  setFontStatus(tr("status.fontRemoved", { name: font.label }));
}

async function uploadTerminalBackground() {
  const file = elements.terminalBackgroundUpload.files?.[0];
  elements.terminalBackgroundUpload.value = "";
  if (!file) return;

  try {
    validateTerminalBackgroundFile(file);
    const url = new URL("./api/terminal-backgrounds", window.location.href);
    url.searchParams.set("filename", file.name);
    const response = await fetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": file.type || mimeTypeForTerminalBackground(file.name) },
      body: file,
    });
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const background = await response.json() as TerminalBackground;
    if (!background.url) throw new Error("invalid background upload response");
    settings.terminalBackgroundUrl = background.url;
    settings.terminalBackgroundEnabled = true;
    saveSettings();
    applySettings();
    setTerminalBackgroundStatus(tr("status.backgroundReady"), "ok");
  } catch (error) {
    setTerminalBackgroundStatus(tr("status.backgroundUploadFailed", { message: errorMessage(error) }), "error");
  }
}

async function removeTerminalBackground() {
  const id = terminalBackgroundIdFromUrl(settings.terminalBackgroundUrl);
  if (!id) {
    settings.terminalBackgroundUrl = "";
    settings.terminalBackgroundEnabled = false;
    saveSettings();
    applySettings();
    setTerminalBackgroundStatus("");
    return;
  }

  const response = await fetch(new URL(`./api/terminal-backgrounds/${encodeURIComponent(id)}`, window.location.href), {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok && response.status !== 404) {
    setTerminalBackgroundStatus(tr("status.backgroundDeleteFailed", { message: await response.text() }), "error");
    return;
  }
  settings.terminalBackgroundUrl = "";
  settings.terminalBackgroundEnabled = false;
  saveSettings();
  applySettings();
  setTerminalBackgroundStatus(tr("status.backgroundRemoved"));
}

function validateFontFile(file: File) {
  const lowerName = file.name.toLowerCase();
  if (!FONT_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(tr("validation.fontExtension"));
  }
  if (file.type && !FONT_MIME_TYPES.has(file.type)) {
    throw new Error(tr("validation.fontMime", { mimeType: file.type }));
  }
  if (file.size <= 0 || file.size > MAX_FONT_BYTES) {
    throw new Error(tr("validation.fontSize"));
  }
}

function mimeTypeForFont(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".woff2")) return "font/woff2";
  if (lowerName.endsWith(".woff")) return "font/woff";
  if (lowerName.endsWith(".ttf")) return "font/ttf";
  if (lowerName.endsWith(".otf")) return "font/otf";
  return "application/octet-stream";
}

function validateTerminalBackgroundFile(file: File) {
  const lowerName = file.name.toLowerCase();
  if (!TERMINAL_BACKGROUND_EXTENSIONS.some((extension) => lowerName.endsWith(extension))) {
    throw new Error(tr("validation.backgroundExtension"));
  }
  if (file.type && !TERMINAL_BACKGROUND_MIME_TYPES.has(file.type)) {
    throw new Error(tr("validation.backgroundMime", { mimeType: file.type }));
  }
  if (file.size <= 0 || file.size > MAX_TERMINAL_BACKGROUND_BYTES) {
    throw new Error(tr("validation.backgroundSize"));
  }
}

function mimeTypeForTerminalBackground(name: string): string {
  const lowerName = name.toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg")) return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";
  return "application/octet-stream";
}

function terminalBackgroundIdFromUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value, window.location.href);
    if (url.origin !== window.location.origin) return "";
    const match = url.pathname.match(/^\/api\/terminal-backgrounds\/([0-9a-f-]+)\/file$/);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

function setFontStatus(message: string, tone: Tone = "neutral") {
  elements.fontStatus.textContent = message;
  elements.fontStatus.dataset.tone = tone;
}

function setTerminalBackgroundStatus(message: string, tone: Tone = "neutral") {
  elements.terminalBackgroundStatus.textContent = message;
  elements.terminalBackgroundStatus.dataset.tone = tone;
}

async function loadPlugins() {
  if (pluginsLoading) return;
  pluginsLoading = true;
  renderPlugins();
  setPluginStatus(tr("status.pluginsLoading"));
  try {
    const response = await capabilityClient.listPlugins({}, { timeoutMs: 10000 });
    plugins = [...response.plugins].sort((left, right) => left.id.localeCompare(right.id));
    pluginsLoaded = true;
    renderPlugins();
    setPluginStatus(tr("status.pluginsReady", { count: plugins.length }), "ok");
  } catch (error) {
    pluginsLoaded = false;
    setPluginStatus(tr("status.pluginLoadFailed", { message: errorMessage(error) }), "error");
  } finally {
    pluginsLoading = false;
    renderPlugins();
  }
}

async function configurePlugin(pluginId: string, enabled: boolean) {
  const plugin = plugins.find((item) => item.id === pluginId);
  if (!plugin || pluginSaveInFlight.has(pluginId)) return;
  pluginSaveInFlight.add(pluginId);
  renderPlugins();
  try {
    const response = await capabilityClient.configurePlugin({
      pluginId,
      enabled,
      metadata: {},
    }, { timeoutMs: 10000 });
    const updated = response.plugin ?? { ...plugin, enabled };
    plugins = plugins.map((item) => item.id === pluginId ? updated : item);
    setPluginStatus(
      tr(enabled ? "status.pluginEnabled" : "status.pluginDisabled", { name: pluginDisplayName(updated) }),
      "ok",
    );
  } catch (error) {
    setPluginStatus(
      tr(enabled ? "status.pluginEnableFailed" : "status.pluginDisableFailed", { message: errorMessage(error) }),
      "error",
    );
  } finally {
    pluginSaveInFlight.delete(pluginId);
    renderPlugins();
  }
}

function renderPlugins() {
  renderPluginSettings();
  renderPluginTools();
}

function renderPluginSettings() {
  if (!plugins.length) {
    elements.pluginList.innerHTML = `<div class="empty">${escapeHtml(pluginsLoading ? tr("status.pluginsLoading") : tr("status.noPlugins"))}</div>`;
    elements.refreshPlugins.disabled = pluginsLoading;
    return;
  }
  elements.refreshPlugins.disabled = pluginsLoading;
  elements.pluginList.innerHTML = plugins.map((plugin) => renderPlugin(plugin)).join("");
  updateIcons();
}

function renderPlugin(plugin: PluginDescriptor): string {
  const saving = pluginSaveInFlight.has(plugin.id);
  const status = plugin.enabled ? tr("setting.pluginEnabled") : tr("setting.pluginDisabled");
  const meta = Array.from(new Set([plugin.kind, ...plugin.scopes].filter(Boolean)))
    .map((item) => pluginMetaLabel(item));
  const settingsTool = plugin.id === AI_CHAT_PLUGIN_ID ? renderAIAccessSettings(plugin) : "";
  return `
    <div class="plugin-item" role="listitem">
      <div class="plugin-content">
        <div class="plugin-title-row">
          <span class="plugin-icon"><i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i></span>
          <span class="plugin-name">${escapeHtml(pluginDisplayName(plugin))}</span>
          <code>${escapeHtml(plugin.id)}</code>
        </div>
        <p class="plugin-description">${escapeHtml(pluginDescription(plugin))}</p>
        <div class="plugin-meta">
          ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
      <label class="switch plugin-switch">
        <input
          type="checkbox"
          data-plugin-toggle="${escapeAttr(plugin.id)}"
          ${plugin.enabled ? "checked" : ""}
          ${saving || pluginsLoading ? "disabled" : ""}
        />
        <span>${escapeHtml(status)}</span>
      </label>
      ${settingsTool}
    </div>
  `;
}

function pluginControlsDisabled(plugin: PluginDescriptor): boolean {
  return !plugin.enabled || pluginSaveInFlight.has(plugin.id) || pluginsLoading;
}

function renderAIAccessSettings(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const disabledAttr = disabled ? "disabled" : "";
  const modelValues = aiModelOptions.includes(settings.aiModel) || !settings.aiModel
    ? aiModelOptions
    : [settings.aiModel, ...aiModelOptions];
  const modelOptions = modelValues.length
    ? modelValues
      .map((model) => `<option value="${escapeAttr(model)}" ${model === settings.aiModel ? "selected" : ""}>${escapeHtml(model)}</option>`)
      .join("")
    : `<option value="" selected disabled>${escapeHtml(tr("action.aiFetchModels"))}</option>`;
  return `
    <div class="plugin-tool ai-access-settings">
      <div class="settings-group-title">${escapeHtml(tr("section.aiAccess"))}</div>
      <p class="settings-help">${escapeHtml(tr("ai.accessHelp"))}</p>
      <div class="ai-config-grid">
        <label class="field">
          <span>${escapeHtml(tr("field.aiProvider"))}</span>
          <select data-ai-setting="provider" ${disabledAttr}>
            <option value="openai-compatible" ${settings.aiProvider === "openai-compatible" ? "selected" : ""}>${escapeHtml(tr("ai.providerOpenAICompatible"))}</option>
          </select>
        </label>
        <label class="field">
          <span>${escapeHtml(tr("field.aiBaseUrl"))}</span>
          <input data-ai-setting="baseUrl" type="url" value="${escapeAttr(settings.aiBaseUrl)}" autocomplete="off" spellcheck="false" placeholder="https://api.openai.com/v1" ${disabledAttr} />
        </label>
        <label class="field">
          <span>${escapeHtml(tr("field.aiApiKey"))}</span>
          <input data-ai-setting="apiKey" type="password" value="${escapeAttr(settings.aiApiKey)}" autocomplete="off" spellcheck="false" ${disabledAttr} />
        </label>
        <label class="field">
          <span>${escapeHtml(tr("field.aiModel"))}</span>
          <select data-ai-setting="model" ${disabledAttr}>
            ${modelOptions}
          </select>
        </label>
        <label class="field checkbox-field">
          <input data-ai-setting="sendContext" type="checkbox" ${settings.aiSendTerminalContext ? "checked" : ""} ${disabledAttr} />
          <span>${escapeHtml(tr("setting.aiSendTerminalContext"))}</span>
        </label>
        <label class="field">
          <span>${escapeHtml(tr("field.aiContextLines"))}</span>
          <input data-ai-setting="contextLines" type="number" min="0" max="200" step="1" value="${escapeAttr(String(settings.aiContextLines))}" ${disabledAttr} />
        </label>
      </div>
      <p class="settings-help">${escapeHtml(tr("setting.aiPrivacyHelp"))}</p>
      <div class="plugin-action-row ai-config-actions">
        <button class="command-button" type="button" data-ai-action="models" ${disabledAttr}>
          <i data-lucide="list-filter"></i>
          <span>${escapeHtml(tr("action.aiFetchModels"))}</span>
        </button>
        <button class="command-button" type="button" data-ai-action="test" ${disabledAttr}>
          <i data-lucide="activity"></i>
          <span>${escapeHtml(tr("action.aiTest"))}</span>
        </button>
      </div>
    </div>
  `;
}

function renderPluginTools() {
  const tools = plugins.filter((plugin) => plugin.enabled && (plugin.id === FILE_TRANSFER_PLUGIN_ID || plugin.id === AI_CHAT_PLUGIN_ID));
  if (!tools.length) {
    activePluginToolId = "";
    elements.pluginToolTabs.innerHTML = "";
    elements.pluginToolBody.innerHTML = `<div class="empty">${escapeHtml(pluginsLoading ? tr("status.pluginsLoading") : tr("status.noPlugins"))}</div>`;
    updateIcons();
    return;
  }
  if (!tools.some((plugin) => plugin.id === activePluginToolId)) {
    activePluginToolId = tools[0]?.id ?? "";
  }
  elements.pluginToolTabs.innerHTML = tools.map((plugin) => `
    <button type="button" role="tab" data-plugin-tool="${escapeAttr(plugin.id)}" aria-selected="${plugin.id === activePluginToolId}" aria-label="${escapeAttr(pluginDisplayName(plugin))}" title="${escapeAttr(pluginDisplayName(plugin))}">
      <i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i>
      <span class="tool-tip">${escapeHtml(pluginDisplayName(plugin))}</span>
    </button>
  `).join("");
  const activePlugin = tools.find((plugin) => plugin.id === activePluginToolId);
  if (activePlugin?.id === FILE_TRANSFER_PLUGIN_ID) {
    syncFileBrowserPathWithActivePane();
  }
  elements.pluginToolBody.innerHTML = activePlugin?.id === FILE_TRANSFER_PLUGIN_ID
    ? renderFileTransferTool(activePlugin)
    : activePlugin?.id === AI_CHAT_PLUGIN_ID
      ? renderAIChatTool(activePlugin)
      : "";
  updateIcons();
  if (activePlugin?.id === FILE_TRANSFER_PLUGIN_ID && !fileBrowserLoading && fileBrowserLoadedPath !== normalizeRemotePath(fileBrowserPath)) {
    void loadFileBrowserDirectory(fileBrowserPath);
  }
  if (activePlugin?.id === AI_CHAT_PLUGIN_ID) {
    scrollAIChatToBottom();
  }
}

function renderFileTransferTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const disabledAttr = disabled ? "disabled" : "";
  const currentPath = normalizeRemotePath(fileBrowserPath);
  const selectedPath = selectedFileBrowserPath || currentPath;
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
          ${renderFileBrowserEntries(disabled)}
        </div>
        ${renderFileBrowserContextMenu(disabled)}
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
          <label class="file-action-button ${disabled ? "is-disabled" : ""}" aria-label="${escapeAttr(tr("action.pluginFileUpload"))}" title="${escapeAttr(tr("action.pluginFileUpload"))}">
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

function renderAIChatTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const disabledAttr = disabled ? "disabled" : "";
  const session = ensureAIChatSession(currentAIModel());
  return `
    <div class="plugin-tool ai-chat-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(tr("plugin.aiChat.name"))}</div>
          <p class="settings-help">${escapeHtml(pluginDescription(plugin))}</p>
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
          ${renderAIChatMessages()}
        </div>
        <div class="ai-chat-composer">
          <div class="ai-chat-model-row">
            ${renderAIChatPicker("model", tr("field.aiModel"), currentAIModel() || tr("action.aiFetchModels"), aiModelValues(), disabled)}
            ${renderAIChatPicker("session", tr("field.aiSession"), session.title, aiChatSessionsForModel(session.model).map((item) => ({ value: item.id, label: item.title })), disabled)}
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

async function runFileTransfer(action: string) {
  if (!pluginIsEnabled(FILE_TRANSFER_PLUGIN_ID)) return;
  if (action === "home") {
    await loadFileBrowserDirectory("/");
    return;
  }
  if (action === "sync-cwd") {
    syncFileBrowserPathWithActivePane(true);
    await loadFileBrowserDirectory(fileBrowserPath);
    return;
  }
  if (action === "parent") {
    await loadFileBrowserDirectory(parentRemotePath(fileBrowserPath));
    return;
  }
  if (action === "refresh" || action === "list") {
    await loadFileBrowserDirectory(fileBrowserPath);
    return;
  }
  if (action === "open") {
    const entry = selectedFileBrowserEntry();
    if (entry?.kind === "directory" || entry?.kind === "symlink") {
      await loadFileBrowserDirectory(entry.path);
    }
    return;
  }
  if (action !== "read" && action !== "stat" && action !== "download") return;
  const path = selectedFileBrowserPath || fileBrowserPath;
  if (!path) {
    setFileTransferOutput(tr("validation.pluginPath"), "error");
    return;
  }
  const pane = activePane();
  if (!pane?.sessionId) {
    setFileTransferOutput(tr("status.pluginFileNoSession"), "error");
    return;
  }
  setFileTransferOutput("");
  try {
    let stream = "";
    const done = await actionClient.send("transfer", action, {
      sessionId: pane.sessionId,
      path,
    }, {
      onStream: (chunk) => {
        stream += chunk;
        setFileTransferOutput(stream, "ok");
      },
      onProgress: (meta) => setFileTransferOutput(transferProgressText(meta), "neutral"),
    });
    if (action === "download") {
      const data = metaString(done.meta, "data");
      if (data) {
        downloadPluginPayload(
          base64ToBytes(data),
          metaString(done.meta, "name") || fileNameFromPath(path),
          metaString(done.meta, "contentType") || "application/octet-stream",
        );
      }
    } else if (!stream) {
      const content = metaString(done.meta, "content");
      if (content) setFileTransferOutput(content, "ok");
    }
    setPluginStatus(tr("status.pluginFileDone", { operation: action }), "ok");
  } catch (error) {
    setFileTransferOutput(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

async function uploadFileTransfer(files: File[]) {
  if (!pluginIsEnabled(FILE_TRANSFER_PLUGIN_ID) || !files.length) return;
  const pane = activePane();
  if (!pane?.sessionId) {
    setFileTransferOutput(tr("status.pluginFileNoSession"), "error");
    return;
  }
  const directory = fileUploadDirectory();
  if (!directory) {
    setFileTransferOutput(tr("validation.pluginPath"), "error");
    return;
  }
  setFileTransferOutput("");
  try {
    let lastMessage = "";
    for (const file of files) {
      const targetPath = uploadTargetPath(directory, file.name);
      const done = await actionClient.uploadFile(file, pane.sessionId, targetPath, {
        onProgress: (meta) => setFileTransferOutput(transferProgressText(meta), "neutral"),
      });
      lastMessage = metaString(done.meta, "content") || transferProgressText(done.meta);
      setFileTransferOutput(lastMessage, "ok");
    }
    await loadFileBrowserDirectory(directory);
    setPluginStatus(tr("status.pluginFileUploadDone", { name: files.length === 1 ? files[0]?.name ?? "" : String(files.length) }), "ok");
  } catch (error) {
    setFileTransferOutput(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

function updateAISetting(field: string, value: string) {
  if (field === "provider") {
    settings.aiProvider = value || DEFAULT_SETTINGS.aiProvider;
  } else if (field === "baseUrl") {
    settings.aiBaseUrl = value.trim();
    aiModelOptions = [];
  } else if (field === "apiKey") {
    settings.aiApiKey = value;
    aiModelOptions = [];
  } else if (field === "model") {
    settings.aiModel = value.trim();
    activeAIChatSessionId = ensureAIChatSession(currentAIModel()).id;
  } else if (field === "session") {
    activeAIChatSessionId = value;
  } else if (field === "sendContext") {
    settings.aiSendTerminalContext = value === "true";
  } else if (field === "contextLines") {
    settings.aiContextLines = Math.round(clampNumber(value, 0, 200, DEFAULT_SETTINGS.aiContextLines));
  }
  saveSettings();
  renderPlugins();
}

async function fetchAIModels() {
  if (!pluginIsEnabled(AI_CHAT_PLUGIN_ID)) return;
  if (!aiAccessConfigured()) {
    appendAIChatSystem(tr("validation.aiAccess"), "error");
    return;
  }
  try {
    const done = await actionClient.send("ai", "models", {});
    const models = metaStringArray(done.meta, "models");
    aiModelOptions = models;
    if (!settings.aiModel && models[0]) {
      settings.aiModel = models[0];
      activeAIChatSessionId = ensureAIChatSession(models[0]).id;
      saveSettings();
    }
    removeAIModelListMessages(models);
    renderPlugins();
    setPluginStatus(tr("status.aiModelsReady", { count: models.length }), "ok");
  } catch (error) {
    appendAIChatSystem(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

async function testAIAccess() {
  if (!pluginIsEnabled(AI_CHAT_PLUGIN_ID)) return;
  if (!aiAccessConfigured()) {
    appendAIChatSystem(tr("validation.aiAccess"), "error");
    return;
  }
  try {
    const done = await actionClient.send("ai", "test", {});
    const models = metaStringArray(done.meta, "models");
    if (models.length) {
      aiModelOptions = models;
      if (!settings.aiModel && models[0]) {
        settings.aiModel = models[0];
        activeAIChatSessionId = ensureAIChatSession(models[0]).id;
        saveSettings();
      }
      renderPlugins();
    }
    const message = metaString(done.meta, "message") || tr("status.aiTestOk");
    const content = metaString(done.meta, "content");
    appendAIChatSystem([message, content].filter(Boolean).join("\n"), "ok");
    setPluginStatus(tr("status.aiTestOk"), "ok");
  } catch (error) {
    appendAIChatSystem(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

async function runAIChat() {
  if (!pluginIsEnabled(AI_CHAT_PLUGIN_ID) || aiChatStreaming) return;
  if (!aiAccessConfigured()) {
    appendAIChatSystem(tr("validation.aiAccess"), "error");
    return;
  }
  const input = document.querySelector<HTMLTextAreaElement>("#aiChatInput");
  const prompt = input?.value.trim() ?? "";
  if (!prompt) {
    appendAIChatSystem(tr("validation.aiPrompt"), "error");
    return;
  }
  const model = currentAIModel();
  if (!model) {
    appendAIChatSystem(tr("action.aiFetchModels"), "error");
    return;
  }
  const session = ensureAIChatSession(model);
  input!.value = "";
  resizeAIChatInput(input!);
  session.messages.push({ role: "user", content: prompt });
  const assistant: AIChatMessage = { role: "assistant", content: "" };
  session.messages.push(assistant);
  aiChatStreaming = true;
  renderPluginTools();
  try {
    await actionClient.send("ai", "chat", {
      input: prompt,
      ctx: terminalAIContext(),
      conversation: session.messages.slice(0, -1).slice(-12),
    }, {
      onStream: (chunk) => {
        assistant.content += chunk;
        renderAIChatMessagesIntoDom();
      },
    });
    if (!assistant.content.trim()) {
      assistant.content = tr("status.aiNoOutput");
      assistant.tone = "neutral";
    }
    setPluginStatus(tr("status.aiTestOk"), "ok");
  } catch (error) {
    assistant.content = errorMessage(error);
    assistant.tone = "error";
    setPluginStatus(errorMessage(error), "error");
  } finally {
    aiChatStreaming = false;
    renderPluginTools();
  }
}

async function copyAIOutput() {
  const session = activeAIChatSession();
  const output = session ? aiChatTranscript(session) : "";
  if (!output) {
    appendAIChatSystem(tr("status.aiNoOutput"), "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(output);
    setPluginStatus(tr("status.selectionCopied"), "ok");
  } catch (error) {
    setPluginStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
  }
}

async function copyAIMessage(index: number) {
  const session = activeAIChatSession();
  const message = Number.isInteger(index) ? session?.messages[index] : undefined;
  const output = message?.content.trim() ?? "";
  if (!output) {
    appendAIChatSystem(tr("status.aiNoOutput"), "error");
    return;
  }
  try {
    await navigator.clipboard.writeText(output);
    setPluginStatus(tr("status.selectionCopied"), "ok");
  } catch (error) {
    setPluginStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
  }
}

function clearAIOutput() {
  const session = activeAIChatSession();
  if (!session) return;
  session.messages = [];
  renderPluginTools();
}

function currentAIModel(): string {
  return settings.aiModel.trim() || aiModelOptions[0] || "";
}

function activeAIChatSession(): AIChatSession | undefined {
  return aiChatSessions.find((session) => session.id === activeAIChatSessionId);
}

function ensureAIChatSession(model: string): AIChatSession {
  const normalizedModel = model.trim() || "default";
  const active = activeAIChatSession();
  if (active?.model === normalizedModel) return active;
  const existing = aiChatSessions.find((session) => session.model === normalizedModel);
  if (existing) {
    activeAIChatSessionId = existing.id;
    return existing;
  }
  const count = aiChatSessions.filter((session) => session.model === normalizedModel).length + 1;
  const session: AIChatSession = {
    id: newId(),
    model: normalizedModel,
    title: `${tr("plugin.aiChat.block")} ${count}`,
    messages: [],
  };
  aiChatSessions = [...aiChatSessions, session];
  activeAIChatSessionId = session.id;
  return session;
}

function newAIChatSession() {
  const model = currentAIModel() || "default";
  const count = aiChatSessions.filter((session) => session.model === model).length + 1;
  const session: AIChatSession = {
    id: newId(),
    model,
    title: `${tr("plugin.aiChat.block")} ${count}`,
    messages: [],
  };
  aiChatSessions = [...aiChatSessions, session];
  activeAIChatSessionId = session.id;
  renderPluginTools();
}

function appendAIChatSystem(content: string, tone: Tone = "neutral") {
  const session = ensureAIChatSession(currentAIModel());
  session.messages.push({ role: "system", content, tone });
  renderPluginTools();
}

function aiModelValues(): Array<{ value: string; label: string }> {
  const values = Array.from(new Set([settings.aiModel, ...aiModelOptions].map((value) => value.trim()).filter(Boolean)));
  if (!values.length) {
    return [{ value: "", label: tr("action.aiFetchModels") }];
  }
  return values.map((model) => ({ value: model, label: model }));
}

function aiChatSessionsForModel(model: string): AIChatSession[] {
  return aiChatSessions.filter((item) => item.model === model);
}

function removeAIModelListMessages(models: string[]) {
  if (models.length < 3) return;
  const modelSet = new Set(models);
  for (const session of aiChatSessions) {
    session.messages = session.messages.filter((message) => {
      if (message.role !== "system" || message.tone !== "ok") return true;
      const lines = message.content.split("\n").map((line) => line.trim()).filter(Boolean);
      return lines.length < 3 || !lines.every((line) => modelSet.has(line));
    });
  }
}

function renderAIChatPicker(
  field: string,
  label: string,
  current: string,
  options: Array<{ value: string; label: string }>,
  disabled: boolean,
): string {
  const selected = field === "model" ? currentAIModel() : activeAIChatSessionId;
  const items = options.map((option) => `
    <option value="${escapeAttr(option.value)}" ${option.value === selected ? "selected" : ""} ${option.value ? "" : "disabled"}>
      ${escapeHtml(option.label)}
    </option>
  `).join("");
  return `
    <label class="ai-chat-picker" title="${escapeAttr(label)}">
      <span class="ai-chat-picker-label">${escapeHtml(label)}</span>
      <span class="ai-chat-select-shell">
        <select data-ai-chat-setting="${escapeAttr(field)}" aria-label="${escapeAttr(label)}" ${disabled ? "disabled" : ""}>
          ${items}
        </select>
        <i data-lucide="chevron-down"></i>
      </span>
    </label>
  `;
}

function renderAIChatMessages(): string {
  const session = ensureAIChatSession(currentAIModel());
  if (!session.messages.length) {
    return `<div class="empty">${escapeHtml(tr("plugin.aiChat.description"))}</div>`;
  }
  return session.messages.map((message, index) => {
    const thinking = message.role === "assistant" && !message.content.trim() && aiChatStreaming;
    const content = thinking
      ? `<div class="ai-thinking" role="status" aria-label="${escapeAttr(tr("status.aiWorking"))}"><span class="ai-thinking-leds" aria-hidden="true"><i></i><i></i><i></i><i></i></span></div>`
      : escapeHtml(message.content);
    return `
    <article class="ai-chat-message ${escapeAttr(message.role)}" data-tone="${escapeAttr(message.tone ?? "neutral")}">
      <div class="ai-chat-message-head">
        <span class="ai-chat-message-role">${escapeHtml(aiChatRoleLabel(message.role))}</span>
        ${message.content.trim() ? `<button class="ai-message-copy" type="button" data-ai-action="copy-message" data-ai-message-index="${escapeAttr(String(index))}" aria-label="${escapeAttr(tr("action.aiCopy"))}" title="${escapeAttr(tr("action.aiCopy"))}"><i data-lucide="copy"></i></button>` : ""}
      </div>
      <div class="ai-chat-message-content ${thinking ? "is-thinking" : ""}">${content}</div>
    </article>
  `;
  }).join("");
}

function renderAIChatMessagesIntoDom() {
  const history = document.querySelector<HTMLElement>("#aiChatHistory");
  if (!history) return;
  history.innerHTML = renderAIChatMessages();
  scrollAIChatToBottom();
}

function aiChatRoleLabel(role: AIChatMessage["role"]): string {
  if (role === "user") return "You";
  if (role === "assistant") return "AI";
  return "WebShell";
}

function scrollAIChatToBottom() {
  const history = document.querySelector<HTMLElement>("#aiChatHistory");
  if (history) history.scrollTop = history.scrollHeight;
}

function resizeAIChatInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 40), 140)}px`;
}

function aiChatTranscript(session: AIChatSession): string {
  return session.messages
    .map((message) => `## ${aiChatRoleLabel(message.role)}\n\n${message.content}`)
    .join("\n\n");
}

function exportAIChat() {
  const session = activeAIChatSession();
  if (!session || !session.messages.length) {
    appendAIChatSystem(tr("status.aiNoOutput"), "error");
    return;
  }
  const bytes = new TextEncoder().encode(aiChatTranscript(session));
  downloadPluginPayload(bytes, `${session.title.replace(/[^\w.-]+/g, "-").toLowerCase() || "ai-chat"}.md`, "text/markdown;charset=utf-8");
}

function pluginIsEnabled(pluginId: string): boolean {
  return plugins.find((plugin) => plugin.id === pluginId)?.enabled ?? false;
}

function aiAccessConfigured(): boolean {
  return Boolean(settings.aiBaseUrl.trim() && settings.aiApiKey.trim());
}

function terminalAIContext(): Record<string, unknown> {
  const pane = activePane();
  const context: Record<string, unknown> = {
    cwd: pane?.workingDirectory ?? "~",
    shell: "sh",
    os: "LightOS",
    selector: selectedSelector,
    sessionId: pane?.sessionId ?? "",
    backend: pane?.sessionBackend ?? "",
    history: [],
    last_command: "",
  };
  if (settings.aiSendTerminalContext && pane) {
    context.recent_output = recentAIContext(pane);
    context.context_lines = settings.aiContextLines;
  }
  return context;
}

function recentAIContext(pane: TerminalPane): string {
  const text = stripAnsiForAI(pane.aiContextText);
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  const selected = settings.aiContextLines > 0 ? lines.slice(-settings.aiContextLines) : [];
  return redactAIContext(selected.join("\n"));
}

function appendAIContext(pane: TerminalPane, text: string) {
  if (!text || pane.sessionBackend !== "webshell") return;
  pane.aiContextText = `${pane.aiContextText}${text}`.slice(-MAX_AI_CONTEXT_CHARS);
  observeWorkingDirectory(pane, text);
}

function stripAnsiForAI(value: string): string {
  return value
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function redactAIContext(value: string): string {
  return value
    .replace(/-----BEGIN [\s\S]*?-----END [A-Z ]+-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\bghp_[A-Za-z0-9_]{16,}\b/g, "[REDACTED_TOKEN]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED_TOKEN]")
    .replace(/\b([A-Z0-9_]*(?:PASS|PASSWORD|TOKEN|SECRET|KEY)[A-Z0-9_]*)=([^\s]+)/gi, "$1=[REDACTED]")
    .replace(/(--password(?:=|\s+))\S+/gi, "$1[REDACTED]")
    .replace(/(-p\s+)\S+/gi, "$1[REDACTED]");
}

function renderFileBrowserEntries(disabled: boolean): string {
  if (fileBrowserLoading) {
    return `<div class="empty">${escapeHtml(tr("status.pluginsLoading"))}</div>`;
  }
  if (!fileBrowserEntries.length) {
    return `<div class="empty">${escapeHtml(tr("status.pluginFileEmpty"))}</div>`;
  }
  return fileBrowserEntries.map((entry) => {
    const selected = entry.path === selectedFileBrowserPath;
    const details = entry.linkTarget
      ? `${fileKindLabel(entry.kind)} -> ${entry.linkTarget}`
      : `${fileKindLabel(entry.kind)} · ${formatFileSize(entry.size)}`;
    return `
      <button
        class="file-browser-entry ${selected ? "selected" : ""}"
        type="button"
        role="option"
        aria-selected="${selected}"
        data-file-entry="${escapeAttr(entry.path)}"
        title="${escapeAttr(entry.path)}"
        ${disabled ? "disabled" : ""}
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

function renderFileBrowserContextMenu(disabled: boolean): string {
  if (!fileBrowserContextMenu || disabled) return "";
  const entry = fileBrowserEntries.find((item) => item.path === fileBrowserContextMenu?.path);
  const path = entry?.path ?? fileBrowserContextMenu.path;
  const canOpen = entry?.kind === "directory" || entry?.kind === "symlink";
  return `
    <div class="file-browser-context-menu" style="left:${fileBrowserContextMenu.x}px;top:${fileBrowserContextMenu.y}px" role="menu">
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

async function activateFileBrowserEntry(path: string, open = false) {
  const entry = fileBrowserEntries.find((item) => item.path === path);
  if (!entry) return;
  selectedFileBrowserPath = entry.path;
  fileBrowserContextMenu = undefined;
  if (open && (entry.kind === "directory" || entry.kind === "symlink")) {
    await loadFileBrowserDirectory(entry.path);
    return;
  }
  renderPluginTools();
}

async function loadFileBrowserDirectory(path: string) {
  if (!pluginIsEnabled(FILE_TRANSFER_PLUGIN_ID)) return;
  const pane = activePane();
  if (!pane?.sessionId) {
    setFileTransferOutput(tr("status.pluginFileNoSession"), "error");
    return;
  }
  const directory = normalizeRemotePath(path);
  fileBrowserLoading = true;
  fileBrowserPath = directory;
  fileBrowserContextMenu = undefined;
  renderPluginTools();
  try {
    let stream = "";
    await actionClient.send("transfer", "list", {
      sessionId: pane.sessionId,
      path: directory,
    }, {
      onStream: (chunk) => {
        stream += chunk;
      },
    });
    fileBrowserEntries = parseFileBrowserEntries(directory, stream);
    selectedFileBrowserPath = "";
    fileBrowserLoadedPath = directory;
    setFileTransferOutput("");
  } catch (error) {
    fileBrowserEntries = [];
    fileBrowserLoadedPath = "";
    setFileTransferOutput(errorMessage(error), "error");
  } finally {
    fileBrowserLoading = false;
    renderPluginTools();
  }
}

function parseFileBrowserEntries(directory: string, text: string): FileBrowserEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): FileBrowserEntry | undefined => {
      const [name = "", rawKind = "", rawSize = "0", rawLinks = "1", linkTarget = ""] = line.split("\t");
      if (!name) return undefined;
      const links = Number.parseInt(rawLinks, 10);
      const kind = fileKindFromFindType(rawKind, Number.isFinite(links) ? links : 1);
      return {
        name,
        path: joinRemotePath(directory, name),
        kind,
        size: Number.parseInt(rawSize, 10) || 0,
        linkTarget: linkTarget || undefined,
      };
    })
    .filter((entry): entry is FileBrowserEntry => Boolean(entry))
    .sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (left.kind !== "directory" && right.kind === "directory") return 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
}

function fileKindFromFindType(value: string, links: number): FileBrowserEntry["kind"] {
  if (value === "d") return "directory";
  if (value === "l") return "symlink";
  if (value === "f" && links > 1) return "hardlink";
  if (value === "f") return "file";
  return "other";
}

function fileEntryIcon(entry: FileBrowserEntry): string {
  if (entry.kind === "directory") return "folder";
  if (entry.kind === "symlink") return "file-symlink";
  if (entry.kind === "hardlink") return "files";
  if (entry.kind === "file") return "file";
  return "file-question";
}

function fileKindLabel(kind: FileBrowserEntry["kind"]): string {
  if (kind === "directory") return tr("fileKind.directory");
  if (kind === "symlink") return tr("fileKind.symlink");
  if (kind === "hardlink") return tr("fileKind.hardlink");
  if (kind === "file") return tr("fileKind.file");
  return tr("fileKind.other");
}

function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} PB`;
}

function selectedFileBrowserEntry(): FileBrowserEntry | undefined {
  return fileBrowserEntries.find((entry) => entry.path === selectedFileBrowserPath);
}

function fileUploadDirectory(): string {
  const entry = selectedFileBrowserEntry();
  if (entry?.kind === "directory") return entry.path;
  return normalizeRemotePath(fileBrowserPath);
}

function syncFileBrowserPathWithActivePane(force = false) {
  const pane = activePane();
  const cwd = normalizeRemotePath(pane?.workingDirectory || "");
  if (!pane || !cwd || cwd === "/") return;
  const paneChanged = fileBrowserPaneId !== pane.id;
  if (!force && !paneChanged && fileBrowserLoadedPath) return;
  fileBrowserPaneId = pane.id;
  fileBrowserPath = cwd;
  selectedFileBrowserPath = "";
  fileBrowserLoadedPath = "";
}

function normalizeRemotePath(path: string): string {
  const trimmed = path.trim().replace(/\/{2,}/g, "/");
  if (!trimmed) return "/";
  if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed.replace(/\/+$/, "") || "~";
  if (trimmed.startsWith("/")) return trimmed.replace(/\/+$/, "") || "/";
  return `/${trimmed}`.replace(/\/+$/, "") || "/";
}

function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/" || normalized === "~") return normalized;
  if (normalized.startsWith("~/")) {
    const homeParts = normalized.slice(2).split("/").filter(Boolean);
    if (homeParts.length <= 1) return "~";
    return `~/${homeParts.slice(0, -1).join("/")}`;
  }
  const parts = normalized.split("/").filter(Boolean);
  return `/${parts.slice(0, -1).join("/")}` || "/";
}

function joinRemotePath(directory: string, name: string): string {
  const safeName = name.replace(/^\/+/, "");
  const base = normalizeRemotePath(directory);
  if (base === "/") return `/${safeName}`;
  return `${base.replace(/\/+$/, "")}/${safeName}`;
}

function observeWorkingDirectory(pane: TerminalPane, text: string) {
  const fromOsc = workingDirectoryFromOsc7(text);
  const fromPrompt = fromOsc || workingDirectoryFromPrompt(text);
  if (!fromPrompt) return;
  pane.workingDirectory = fromPrompt;
  if (pane.id === activePane()?.id && activePluginToolId === FILE_TRANSFER_PLUGIN_ID && !fileBrowserLoadedPath) {
    syncFileBrowserPathWithActivePane();
  }
}

function workingDirectoryFromOsc7(text: string): string {
  const pattern = /\x1b\]7;file:\/\/[^\x07\x1b/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let cwd = "";
  while ((match = pattern.exec(text)) !== null) {
    try {
      cwd = decodeURIComponent(match[1] ?? "");
    } catch {
      cwd = match[1] ?? "";
    }
  }
  return normalizeDetectedDirectory(cwd);
}

function workingDirectoryFromPrompt(text: string): string {
  const clean = stripAnsiForAI(text).split(/\r?\n/).slice(-4).join("\n");
  const pattern = /(?:^|[\s:>])((?:~|\/)[\w.@%+\-/]*)(?=$|[\s)>])/g;
  let match: RegExpExecArray | null;
  let cwd = "";
  while ((match = pattern.exec(clean)) !== null) {
    const candidate = match[1] ?? "";
    if (candidate.length > cwd.length) cwd = candidate;
  }
  return normalizeDetectedDirectory(cwd);
}

function normalizeDetectedDirectory(value: string): string {
  const cleaned = value.trim().replace(/[.,;:)\]]+$/g, "");
  if (!cleaned || cleaned === "/" || cleaned.includes("\n")) return "";
  if (cleaned === "~" || cleaned.startsWith("~/") || cleaned.startsWith("/")) {
    return normalizeRemotePath(cleaned);
  }
  return "";
}

function uploadTargetPath(path: string, fileName: string): string {
  return joinRemotePath(path, fileName);
}

function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || "download";
}

function setFileTransferOutput(message: string, tone: Tone = "neutral") {
  const output = document.querySelector<HTMLElement>("#fileTransferOutput");
  if (!output) return;
  output.textContent = message;
  output.dataset.tone = tone;
}

function downloadPluginPayload(payload: Uint8Array, name: string, contentType: string) {
  const bytes = new Uint8Array(payload);
  const blob = new Blob([bytes.buffer], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function transferProgressText(meta: ActionResponseMeta | undefined): string {
  const name = metaString(meta, "name");
  const percent = metaNumber(meta, "percent");
  const done = metaBoolean(meta, "done");
  const status = `${Number.isFinite(percent) ? `${percent}%` : "..."}`;
  return [name, done ? `${status} complete` : status].filter(Boolean).join(": ");
}

function metaString(meta: ActionResponseMeta | undefined, key: string): string {
  const value = meta?.[key];
  return typeof value === "string" ? value : "";
}

function metaNumber(meta: ActionResponseMeta | undefined, key: string): number {
  const value = meta?.[key];
  return typeof value === "number" ? value : Number.NaN;
}

function metaBoolean(meta: ActionResponseMeta | undefined, key: string): boolean {
  return meta?.[key] === true;
}

function stringField(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function recordField(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function boolField(record: JsonRecord | undefined, key: string): boolean {
  return record?.[key] === true;
}

function metaStringArray(meta: ActionResponseMeta | undefined, key: string): string[] {
  const value = meta?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function pluginDisplayName(plugin: PluginDescriptor): string {
  if (plugin.id === AI_CHAT_PLUGIN_ID) return tr("plugin.aiChat.name");
  if (plugin.id === FILE_TRANSFER_PLUGIN_ID) return tr("plugin.fileTransfer.name");
  return plugin.displayName || plugin.id;
}

function pluginIcon(pluginId: string): string {
  if (pluginId === AI_CHAT_PLUGIN_ID) return "message-square-text";
  if (pluginId === FILE_TRANSFER_PLUGIN_ID) return "folder-up";
  return "plug";
}

function pluginDescription(plugin: PluginDescriptor): string {
  if (plugin.id === AI_CHAT_PLUGIN_ID) return tr("plugin.aiChat.description");
  if (plugin.id === FILE_TRANSFER_PLUGIN_ID) return tr("plugin.fileTransfer.description");
  return plugin.description || plugin.kind || plugin.id;
}

function pluginMetaLabel(value: string): string {
  if (value === "ai") return tr("plugin.meta.ai");
  if (value === "filesystem") return tr("plugin.meta.filesystem");
  if (value === "session") return tr("plugin.meta.session");
  if (value === "transfer") return tr("plugin.meta.transfer");
  return value;
}

function setPluginStatus(message: string, tone: Tone = "neutral") {
  elements.pluginStatus.textContent = message;
  elements.pluginStatus.dataset.tone = tone;
}

async function loadInstances() {
  setGlobalStatus(tr("status.loadingInstances"));
  try {
    instances = await fetchInstances();
    const reconcile = reconcileSelectedInstance();
    renderInstances();
    if (reconcile.explicitFallback && selectedSelector) {
      setGlobalStatus(tr("status.instanceFallback", { selector: selectorLabel(selectedSelector) }));
    } else {
      setGlobalStatus(instances.length ? tr("status.instancesLoaded") : tr("status.noInstances"));
    }
  } catch (error) {
    renderInstances();
    setGlobalStatus(tr("status.instanceLoadFailed", { message: errorMessage(error) }), "error");
  }
}

async function fetchInstances(): Promise<Instance[]> {
  const response = await fetch(new URL("./api/instances", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const payload = await response.json() as unknown;
  if (!Array.isArray(payload)) {
    throw new Error("invalid instances response");
  }
  return payload as Instance[];
}

function reconcileSelectedInstance(): { selected: boolean; explicitFallback: boolean } {
  const current = normalizeSelector(selectedSelector);
  const selected = current ? instances.find((instance) => instanceSelector(instance) === current) : undefined;
  if (selected && isRunningInstance(selected)) {
    setSelectedSelector(current, {
      replaceLocation: true,
      tabId: activeTabId ?? requestedTabIdFromLocation(),
      updateLocation: true,
    });
    rememberSelector(current);
    updateSelectedInstanceChrome();
    return { selected: true, explicitFallback: false };
  }

  const rememberedSelector = selectedSelectorExplicit ? "" : readRememberedSelector();
  const rememberedRunning = rememberedSelector
    ? instances.find((instance) => instanceSelector(instance) === rememberedSelector && isRunningInstance(instance))
    : undefined;
  const runningSelector = instanceSelector(rememberedRunning ?? instances.find(isRunningInstance));
  if (runningSelector) {
    setSelectedSelector(runningSelector, { updateLocation: true, replaceLocation: true, tabId: "" });
    rememberSelector(runningSelector);
    updateSelectedInstanceChrome();
    return { selected: true, explicitFallback: selectedSelectorExplicit && Boolean(current) };
  }

  setSelectedSelector(current, { updateLocation: false });
  updateSelectedInstanceChrome();
  return { selected: false, explicitFallback: false };
}

function updateSelectedInstanceChrome() {
  elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : tr("status.noTarget");
  elements.instanceStatusDot.dataset.status = selectedSelector ? selectedInstance()?.status ?? "unknown" : "unknown";
}

function renderInstances() {
  if (!instances.length) {
    elements.instanceList.innerHTML = `<div class="empty">${escapeHtml(tr("status.noInstancesVisible"))}</div>`;
    return;
  }
  elements.instanceList.innerHTML = instances.map((instance) => {
    const selector = instanceSelector(instance);
    const running = isRunningInstance(instance);
    const active = selector === selectedSelector;
    return `
      <button class="instance-row ${active ? "selected" : ""}" data-selector="${escapeAttr(selector)}" ${running ? "" : "disabled"} type="button">
        <span>
          <strong>${escapeHtml(instance.name || selector)}</strong>
        </span>
        <em class="${running ? "ok" : "muted"}">${escapeHtml(instance.status ?? "unknown")}</em>
      </button>
    `;
  }).join("");
  elements.instanceList.querySelectorAll<HTMLButtonElement>(".instance-row").forEach((button) => {
    button.addEventListener("click", () => {
      const selector = normalizeSelector(button.dataset.selector ?? "");
      selectedSelectorExplicit = true;
      setSelectedSelector(selector, { updateLocation: true, replaceLocation: false, tabId: "" });
      rememberSelector(selector);
      updateSelectedInstanceChrome();
      closeInstanceMenu();
      renderInstances();
      if (selectedSelector) {
        void loadWorkspace(selectedSelector);
      }
    });
  });
}

async function loadWorkspace(selector: string, options: { allowReconcileRetry?: boolean } = {}) {
  const requestSelector = normalizeSelector(selector);
  const generation = selectedSelectorGeneration;
  clearSessionBackendsState();
  clearHerdrState();
  try {
    const workspace = await fetchWorkspace(requestSelector);
    const applied = await applyWorkspaceState(workspace, {
      generation,
      replayFromStart: true,
      selector: requestSelector,
    });
    if (applied) {
      void refreshSessionBackends(requestSelector, generation);
      void refreshHerdrState(requestSelector, generation);
    }
  } catch (error) {
    if (
      options.allowReconcileRetry !== false
      && isCurrentSelectorRequest(requestSelector, generation)
      && reconcileSelectedInstance().selected
      && selectedSelector !== requestSelector
    ) {
      renderInstances();
      await loadWorkspace(selectedSelector, { allowReconcileRetry: false });
      return;
    }
    if (!isCurrentSelectorRequest(requestSelector, generation)) return;
    clearHerdrState();
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function fetchWorkspace(selector: string): Promise<WorkspaceState> {
  if (!selector) {
    throw new Error(tr("status.selectRunningInstance"));
  }
  const url = new URL("./api/workspace", window.location.href);
  url.searchParams.set("name", selector);
  url.searchParams.set("cols", String(INITIAL_COLS));
  url.searchParams.set("rows", String(INITIAL_ROWS));
  url.searchParams.set("output_limit", String(settings.outputBufferLimit));
  url.searchParams.set("auto_restart", String(settings.autoRestartSessions));
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  return response.json() as Promise<WorkspaceState>;
}

async function runWorkspaceAction(
  action: WorkspaceAction,
  options: {
    selector?: string;
    tabId?: string;
    paneId?: string;
    direction?: SplitPlacement;
    label?: string;
    layout?: SplitNode;
    activePaneId?: string;
    sessionBackend?: SessionBackendId;
    apply?: boolean;
  } = {},
): Promise<WorkspaceState | undefined> {
  const selector = options.selector ?? activeTab()?.selector ?? selectedSelector;
  if (!selector) return undefined;
  const response = await fetch(new URL("./api/workspace", window.location.href), {
    method: "PUT",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: selector,
      action,
      tab_id: options.tabId,
      pane_id: options.paneId,
      direction: options.direction,
      label: options.label,
      layout: options.layout,
      active_pane_id: options.activePaneId,
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      output_limit: settings.outputBufferLimit,
      auto_restart: settings.autoRestartSessions,
      session_backend: options.sessionBackend,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const workspace = await response.json() as WorkspaceState;
  if (options.apply !== false) {
    await applyWorkspaceState(workspace, {
      generation: selectedSelectorGeneration,
      preferStateActiveTab: true,
      selector,
    });
  }
  return workspace;
}

async function refreshSessionBackends(
  selector: string,
  generation = selectedSelectorGeneration,
): Promise<boolean> {
  const requestSelector = normalizeSelector(selector);
  if (!requestSelector) {
    clearSessionBackendsState();
    return false;
  }
  const requestId = ++sessionBackendsGeneration;
  try {
    const state = await fetchSessionBackends(requestSelector);
    if (requestId !== sessionBackendsGeneration || !isCurrentSelectorRequest(requestSelector, generation)) {
      return false;
    }
    sessionBackendsState = state;
    renderHerdrDock();
    return true;
  } catch (error) {
    if (requestId === sessionBackendsGeneration && isCurrentSelectorRequest(requestSelector, generation)) {
      clearSessionBackendsState();
      if (settings.debugMode) {
        setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
      }
    }
    return false;
  }
}

async function fetchSessionBackends(selector: string): Promise<SessionBackendsState> {
  const url = new URL("./api/session-backends", window.location.href);
  url.searchParams.set("name", selector);
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  return response.json() as Promise<SessionBackendsState>;
}

function clearSessionBackendsState() {
  sessionBackendsGeneration += 1;
  sessionBackendsState = undefined;
  renderHerdrDock();
}

async function refreshHerdrState(
  selector: string,
  generation = selectedSelectorGeneration,
): Promise<boolean> {
  const requestSelector = normalizeSelector(selector);
  if (!requestSelector) {
    clearHerdrState();
    return false;
  }
  const requestId = ++herdrStateGeneration;
  try {
    const state = await fetchHerdrState(requestSelector);
    if (requestId !== herdrStateGeneration || !isCurrentSelectorRequest(requestSelector, generation)) {
      return false;
    }
    if (!state.available) {
      clearHerdrState();
      return false;
    }
    herdrState = state;
    renderTabs();
    renderHerdrDock();
    void maybeAutoRestoreHerdrEntry(requestSelector);
    return true;
  } catch (error) {
    if (requestId === herdrStateGeneration && isCurrentSelectorRequest(requestSelector, generation)) {
      clearHerdrState();
      if (settings.debugMode) {
        setGlobalStatus(tr("status.herdrActionFailed", { message: errorMessage(error) }), "error");
      }
    }
    return false;
  }
}

async function maybeAutoRestoreHerdrEntry(selector: string) {
  const normalized = normalizeSelector(selector);
  if (!normalized || settings.defaultSessionBackend !== "herdr") return;
  if (!backendInstalled("herdr") || !herdrState?.available || !herdrState.workspaces.length) return;
  if (findPaneBySessionBackend(normalized, "herdr")) return;
  if (herdrAutoRestoredSelectors.has(normalized)) return;
  herdrAutoRestoredSelectors.add(normalized);
  try {
    await runWorkspaceAction("create_tab", { selector: normalized, sessionBackend: "herdr" });
    setGlobalStatus(tr("status.herdrEntryRestored"), "ok");
  } catch (error) {
    if (settings.debugMode) {
      setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
    }
  } finally {
    herdrAutoRestoredSelectors.delete(normalized);
  }
}

async function fetchHerdrState(selector: string): Promise<HerdrBridgeState> {
  const url = new URL("./api/herdr", window.location.href);
  url.searchParams.set("name", selector);
  const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  return response.json() as Promise<HerdrBridgeState>;
}

async function runHerdrAction(
  action: HerdrAction,
  options: {
    workspaceId?: string;
    tabId?: string;
  } = {},
) {
  const selector = selectedSelector;
  if (!selector || !herdrState?.available) return;
  elements.herdrStatus.textContent = "";
  try {
    const response = await fetch(new URL("./api/herdr", window.location.href), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: selector,
        action,
        workspace_id: options.workspaceId,
        tab_id: options.tabId,
      }),
    });
    if (!response.ok) {
      throw new Error(await response.text() || response.statusText);
    }
    const state = await response.json() as HerdrBridgeState;
    if (!isCurrentSelectorRequest(selector, selectedSelectorGeneration) || !state.available) {
      clearHerdrState();
      return;
    }
    herdrState = state;
    renderHerdrDock();
    activePane()?.term?.focus();
  } catch (error) {
    elements.herdrStatus.textContent = tr("status.herdrActionFailed", { message: errorMessage(error) });
  }
}

async function ensureHerdrEntry(selector = selectedSelector): Promise<boolean> {
  const normalized = normalizeSelector(selector);
  if (!normalized || !sessionBackendIsSelectable("herdr")) return false;
  const existing = findPaneBySessionBackend(normalized, "herdr");
  if (existing) {
    activatePane(existing.tab.id, existing.pane.id);
    return true;
  }
  try {
    await runWorkspaceAction("create_tab", { selector: normalized, sessionBackend: "herdr" });
    return true;
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function restoreHerdrWorkspace(workspaceId: string | undefined) {
  const normalized = normalizeSelector(workspaceId);
  if (!normalized) return;
  const selector = selectedSelector;
  if (!selector) {
    setGlobalStatus(tr("status.selectRunningInstance"), "error");
    return;
  }
  const entryReady = await ensureHerdrEntry(selector);
  if (!entryReady) return;
  const stateReady = herdrState?.available || await refreshHerdrState(selector);
  if (!stateReady) {
    setGlobalStatus(tr("status.herdrUnavailable"), "error");
    return;
  }
  await runHerdrAction("focus_workspace", { workspaceId: normalized });
  setGlobalStatus(tr("status.herdrWorkspaceFocused"), "ok");
}

async function runHerdrSocketRequest(
  method: string,
  params: JsonRecord = {},
  options: { selector?: string; id?: string; mirrorNotification?: boolean } = {},
): Promise<HerdrSocketEnvelope> {
  const selector = normalizeSelector(options.selector ?? selectedSelector);
  if (!selector) throw new Error(tr("status.selectRunningInstance"));
  const response = await fetch(new URL("./api/herdr/socket", window.location.href), {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: selector,
      method,
      params,
      id: options.id,
    }),
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const envelope = await response.json() as HerdrSocketEnvelope;
  if (method === "notification.show" && options.mirrorNotification !== false) {
    mirrorHerdrNotification(params, envelope);
  }
  if (envelope.error) {
    throw new Error(envelope.error.message || envelope.error.code || "Herdr socket request failed");
  }
  return envelope;
}

function mirrorHerdrNotification(params: JsonRecord, envelope: HerdrSocketEnvelope) {
  const title = stringField(params, "title");
  const body = stringField(params, "body");
  const shown = envelope.result ? boolField(envelope.result, "shown") : false;
  const reason = envelope.result ? stringField(envelope.result, "reason") : "";
  const message = [title, body].filter(Boolean).join(" - ");
  if (message) {
    setGlobalStatus(tr("status.herdrNotification", { message }), shown || !reason ? "ok" : "neutral");
  }
}

async function fetchHerdrPaneIds(selector: string): Promise<string[]> {
  const envelope = await runHerdrSocketRequest("pane.list", {}, {
    selector,
    id: "lazycat-webshell:pane-list",
    mirrorNotification: false,
  });
  const panes = envelope.result?.panes;
  if (!Array.isArray(panes)) return [];
  return panes
    .map((pane) => pane && typeof pane === "object" ? stringField(pane as JsonRecord, "pane_id") : "")
    .filter(Boolean);
}

async function syncHerdrEventBridge(options: { force?: boolean } = {}) {
  const selector = normalizeSelector(selectedSelector);
  const activeMode = activePane()?.sessionBackend;
  const shouldSubscribe = Boolean(selector && herdrState?.available && activeMode === "herdr");
  if (!shouldSubscribe) {
    stopHerdrEventBridge();
    return;
  }
  if (
    !options.force
    && herdrEventSocketSelector === selector
    && (herdrEventSocket?.readyState === WebSocket.OPEN || herdrEventSocket?.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  closeHerdrEventSocket();
  const generation = ++herdrEventSocketGeneration;
  const paneIds = await fetchHerdrPaneIds(selector).catch((error) => {
    if (settings.debugMode) {
      setGlobalStatus(tr("status.herdrActionFailed", { message: errorMessage(error) }), "error");
    }
    return [];
  });
  if (generation !== herdrEventSocketGeneration || normalizeSelector(selectedSelector) !== selector) return;

  const url = new URL("./ws/herdr", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("name", selector);
  const socket = new WebSocket(url);
  herdrEventSocket = socket;
  herdrEventSocketSelector = selector;
  socket.addEventListener("open", () => {
    if (herdrEventSocket !== socket || generation !== herdrEventSocketGeneration) return;
    socket.send(JSON.stringify({
      id: "lazycat-webshell:events",
      method: "events.subscribe",
      params: {
        subscriptions: herdrEventSubscriptions(paneIds),
      },
    }));
  });
  socket.addEventListener("message", (event) => {
    if (herdrEventSocket !== socket || generation !== herdrEventSocketGeneration) return;
    handleHerdrEventMessage(event.data);
  });
  socket.addEventListener("close", () => {
    if (herdrEventSocket !== socket || generation !== herdrEventSocketGeneration) return;
    herdrEventSocket = undefined;
    scheduleHerdrEventReconnect(selector, generation);
  });
  socket.addEventListener("error", () => {
    if (herdrEventSocket === socket && settings.debugMode) {
      setGlobalStatus(tr("status.herdrUnavailable"), "error");
    }
  });
}

function herdrEventSubscriptions(paneIds: string[]): JsonRecord[] {
  const subscriptions: JsonRecord[] = [
    { type: "workspace.created" },
    { type: "workspace.renamed" },
    { type: "workspace.closed" },
    { type: "workspace.focused" },
    { type: "tab.created" },
    { type: "tab.closed" },
    { type: "tab.focused" },
    { type: "tab.renamed" },
    { type: "pane.created" },
    { type: "pane.closed" },
    { type: "pane.moved" },
    { type: "pane.exited" },
    { type: "pane.agent_detected" },
  ];
  for (const paneId of paneIds) {
    subscriptions.push({ type: "pane.agent_status_changed", pane_id: paneId });
  }
  return subscriptions;
}

function handleHerdrEventMessage(raw: unknown) {
  const text = typeof raw === "string" ? raw : "";
  if (!text) return;
  let envelope: HerdrSocketEnvelope;
  try {
    envelope = JSON.parse(text) as HerdrSocketEnvelope;
  } catch {
    return;
  }
  if (envelope.error) {
    if (settings.debugMode) {
      setGlobalStatus(tr("status.herdrActionFailed", { message: envelope.error.message || envelope.error.code || "" }), "error");
    }
    return;
  }
  if (!envelope.event) return;
  const event = envelope.event;
  const data = envelope.data ?? {};
  const message = herdrEventMessage(event, data);
  if (message) {
    setGlobalStatus(message, herdrEventTone(event, data));
  }
  if (herdrEventChangesDock(event)) {
    scheduleHerdrEventRefresh();
  }
}

function herdrEventMessage(event: string, data: JsonRecord): string {
  if (event === "pane.agent_status_changed") {
    const status = stringField(data, "agent_status") || stringField(data, "state") || stringField(data, "custom_status");
    const agent = stringField(data, "display_agent") || stringField(data, "agent") || "agent";
    const detail = stringField(data, "message") || stringField(data, "custom_status") || status;
    return tr("status.herdrEventAgent", { agent, status: detail || status || "updated" });
  }
  if (event === "pane.agent_detected") {
    const agent = stringField(data, "agent") || "agent";
    return tr("status.herdrEventAgent", { agent, status: "detected" });
  }
  const subject = stringField(data, "pane_id")
    || stringField(data, "tab_id")
    || stringField(data, "workspace_id")
    || event;
  return tr("status.herdrEvent", { event, subject });
}

function herdrEventTone(event: string, data: JsonRecord): Tone {
  if (event === "pane.exited") return "error";
  const status = stringField(data, "agent_status") || stringField(data, "state");
  if (status === "blocked") return "error";
  if (status === "done" || status === "idle") return "ok";
  return "neutral";
}

function herdrEventChangesDock(event: string): boolean {
  return event.startsWith("workspace.")
    || event.startsWith("tab.")
    || event === "pane.created"
    || event === "pane.closed"
    || event === "pane.focused"
    || event === "pane.moved"
    || event === "pane.exited";
}

function scheduleHerdrEventRefresh() {
  window.clearTimeout(herdrEventRefreshTimer);
  herdrEventRefreshTimer = window.setTimeout(() => {
    if (!selectedSelector) return;
    void refreshHerdrState(selectedSelector);
    void syncHerdrEventBridge({ force: true });
  }, 300);
}

function scheduleHerdrEventReconnect(selector: string, generation: number) {
  window.clearTimeout(herdrEventReconnectTimer);
  herdrEventReconnectTimer = window.setTimeout(() => {
    if (generation !== herdrEventSocketGeneration || normalizeSelector(selectedSelector) !== selector) return;
    void syncHerdrEventBridge({ force: true });
  }, 2000);
}

function stopHerdrEventBridge() {
  herdrEventSocketGeneration += 1;
  closeHerdrEventSocket();
}

function closeHerdrEventSocket() {
  window.clearTimeout(herdrEventReconnectTimer);
  window.clearTimeout(herdrEventRefreshTimer);
  herdrEventReconnectTimer = undefined;
  herdrEventRefreshTimer = undefined;
  const socket = herdrEventSocket;
  herdrEventSocket = undefined;
  herdrEventSocketSelector = "";
  socket?.close();
}

function clearHerdrState() {
  herdrStateGeneration += 1;
  herdrState = undefined;
  stopHerdrEventBridge();
  renderHerdrWorkspaceMenu();
  renderTabs();
  renderHerdrDock();
}

function renderHerdrDock() {
  const hasHerdrControls = Boolean(herdrState?.available);
  const activeMode = activePane()?.sessionBackend;
  const showHerdrControls = hasHerdrControls && activeMode === "herdr";
  updateSessionBackendSettings();
  if (!showHerdrControls) {
    elements.webshell.classList.remove("has-herdr");
    elements.herdrDock.hidden = true;
    elements.herdrWorkspaceList.hidden = false;
    elements.herdrTabList.parentElement?.removeAttribute("hidden");
    elements.herdrNewWorkspace.hidden = false;
    elements.herdrNewTab.hidden = false;
    elements.herdrWorkspaceList.replaceChildren();
    elements.herdrTabList.replaceChildren();
    elements.herdrStatus.textContent = "";
    renderHerdrWorkspaceMenu();
    void syncHerdrEventBridge();
    return;
  }

  elements.webshell.classList.add("has-herdr");
  elements.herdrDock.hidden = false;
  elements.herdrWorkspaceList.hidden = false;
  elements.herdrTabList.parentElement?.toggleAttribute("hidden", false);
  elements.herdrNewWorkspace.hidden = false;
  elements.herdrNewTab.hidden = false;
  elements.herdrWorkspaceList.innerHTML = herdrState?.workspaces.length
    ? herdrState.workspaces.map(renderHerdrWorkspaceButton).join("")
    : "";
  elements.herdrTabList.innerHTML = herdrState?.tabs.length
    ? herdrState.tabs.map(renderHerdrTabButton).join("")
    : "";
  elements.herdrStatus.textContent = herdrState?.message ?? "";
  renderHerdrWorkspaceMenu();
  void syncHerdrEventBridge();
  updateIcons();
}

function normalizeSessionMode(value: unknown): SessionMode {
  return value === "herdr" || value === "zellij" ? value : "webshell";
}

function sessionBackendIsSelectable(mode: SessionMode): boolean {
  if (mode === "webshell") return true;
  return selectableSessionBackends().some((backend) => backend.id === mode);
}

function findPaneBySessionBackend(
  selector: string,
  mode: SessionMode,
): { tab: TerminalTab; pane: TerminalPane } | undefined {
  const normalizedSelector = normalizeSelector(selector);
  const sameSelectorTabs = tabs.filter((tab) => normalizeSelector(tab.selector) === normalizedSelector);
  for (const tab of sameSelectorTabs) {
    const pane = activePane(tab);
    if (pane?.sessionBackend === mode) return { tab, pane };
  }
  for (const tab of sameSelectorTabs) {
    const pane = tab.panes.find((item) => item.sessionBackend === mode);
    if (pane) return { tab, pane };
  }
  return undefined;
}

function sessionBackendLabel(id: SessionBackendId, fallback: string): string {
  if (id === "webshell") return tr("backend.webshell");
  if (id === "herdr") return tr("backend.herdr");
  if (id === "zellij") return tr("backend.zellij");
  return fallback;
}

function renderNewTabMenu() {
  const selectable = selectableSessionBackends();
  elements.newTabMenu.innerHTML = selectable.map((backend) => {
    const id = backend.id;
    const selected = id === preferredBackendForNewTab();
    const label = sessionBackendLabel(id, backend.label);
    const icon = id === "herdr" ? "panels-top-left" : id === "zellij" ? "layout-dashboard" : "terminal";
    return `
      <button type="button" role="menuitem" data-new-tab-backend="${escapeAttr(id)}" data-default-backend="${selected}">
        <i data-lucide="${escapeAttr(icon)}"></i>
        <span>${escapeHtml(label)}</span>
        ${selected ? `<small>${escapeHtml(tr("status.defaultBackend"))}</small>` : ""}
      </button>
    `;
  }).join("");
  updateIcons();
}

function toggleNewTabMenu() {
  if (elements.newTabMenu.hidden) {
    renderNewTabMenu();
    elements.newTabMenu.hidden = false;
    positionNewTabMenu();
    elements.newTabButton.setAttribute("aria-expanded", "true");
    return;
  }
  closeNewTabMenu();
}

function positionNewTabMenu() {
  elements.newTabMenu.style.left = "";
  elements.newTabMenu.style.top = "";
  elements.newTabMenu.style.right = "auto";
  elements.newTabMenu.style.bottom = "auto";
  requestAnimationFrame(() => {
    if (elements.newTabMenu.hidden) return;
    const margin = 8;
    const buttonRect = elements.newTabButton.getBoundingClientRect();
    const menuRect = elements.newTabMenu.getBoundingClientRect();
    const vertical = elements.webshell.dataset.tabLayout === "vertical";
    const preferredLeft = vertical
      ? buttonRect.right + 8
      : buttonRect.right - menuRect.width;
    const fallbackLeft = buttonRect.left - menuRect.width - 8;
    const maxLeft = Math.max(margin, window.innerWidth - menuRect.width - margin);
    const maxTop = Math.max(margin, window.innerHeight - menuRect.height - margin);
    const unclampedLeft = vertical && preferredLeft > maxLeft ? fallbackLeft : preferredLeft;
    const top = vertical ? buttonRect.top : buttonRect.bottom + 8;
    elements.newTabMenu.style.left = `${Math.min(Math.max(margin, unclampedLeft), maxLeft)}px`;
    elements.newTabMenu.style.top = `${Math.min(Math.max(margin, top), maxTop)}px`;
  });
}

function closeNewTabMenu() {
  elements.newTabMenu.hidden = true;
  elements.newTabMenu.style.left = "";
  elements.newTabMenu.style.top = "";
  elements.newTabMenu.style.right = "";
  elements.newTabMenu.style.bottom = "";
  elements.newTabButton.setAttribute("aria-expanded", "false");
}

async function toggleHerdrWorkspaceMenu() {
  if (elements.herdrWorkspaceMenu.hidden) {
    await openHerdrWorkspaceMenu();
    return;
  }
  closeHerdrWorkspaceMenu();
}

async function openHerdrWorkspaceMenu() {
  elements.herdrWorkspaceMenu.hidden = false;
  elements.herdrWorkspaceButton.setAttribute("aria-expanded", "true");
  renderHerdrWorkspaceMenu();
  if (selectedSelector) {
    await refreshHerdrState(selectedSelector);
  }
  renderHerdrWorkspaceMenu();
  updateIcons();
}

function closeHerdrWorkspaceMenu() {
  elements.herdrWorkspaceMenu.hidden = true;
  elements.herdrWorkspaceButton.setAttribute("aria-expanded", "false");
}

function renderHerdrWorkspaceMenu() {
  if (!backendInstalled("herdr")) {
    elements.herdrWorkspaceMenuList.replaceChildren();
    elements.herdrWorkspaceMenuStatus.textContent = "";
    return;
  }
  const workspaces = herdrState?.workspaces ?? [];
  elements.herdrWorkspaceMenuList.innerHTML = workspaces.length
    ? workspaces.map(renderHerdrWorkspaceMenuRow).join("")
    : `<div class="empty">${escapeHtml(herdrState?.message || tr("status.herdrUnavailable"))}</div>`;
  elements.herdrWorkspaceMenuStatus.textContent = herdrState?.message ?? "";
  updateIcons();
}

function renderHerdrWorkspaceMenuRow(workspace: HerdrWorkspaceInfo): string {
  const label = workspace.label.trim() || `Workspace ${workspace.number || ""}`.trim();
  const detail = `${workspace.tab_count} ${tr("field.tabs")} · ${workspace.pane_count} ${tr("field.panes")}`;
  return `
    <div class="herdr-workspace-row-shell ${workspace.focused ? "selected" : ""}" role="option" aria-selected="${workspace.focused}">
      <button class="herdr-workspace-row" type="button" data-herdr-workspace="${escapeAttr(workspace.workspace_id)}">
        <span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(detail)}</small>
        </span>
        ${workspace.focused ? `<i data-lucide="check"></i>` : ""}
      </button>
      <button class="herdr-workspace-close" type="button" data-herdr-close-workspace="${escapeAttr(workspace.workspace_id)}" aria-label="${escapeAttr(tr("action.closeHerdrSpace"))}" title="${escapeAttr(tr("action.closeHerdrSpace"))}">
        <i data-lucide="x"></i>
      </button>
    </div>
  `;
}

function renderHerdrWorkspaceButton(workspace: HerdrWorkspaceInfo): string {
  const label = workspace.label.trim() || `Workspace ${workspace.number || ""}`.trim();
  const details = `${workspace.tab_count} tabs, ${workspace.pane_count} panes`;
  const number = String(workspace.number || "").trim();
  return `
    <div class="herdr-space" role="option" aria-selected="${workspace.focused}" title="${escapeAttr(`${label} · ${details}`)}">
      <button class="herdr-chip" type="button" data-herdr-workspace="${escapeAttr(workspace.workspace_id)}">
        ${number ? `<small>${escapeHtml(number)}</small>` : ""}
        <span>${escapeHtml(label)}</span>
      </button>
      <button class="herdr-space-close" type="button" data-herdr-close-workspace="${escapeAttr(workspace.workspace_id)}" aria-label="${escapeAttr(tr("action.closeHerdrSpace"))}" title="${escapeAttr(tr("action.closeHerdrSpace"))}">
        <i data-lucide="x"></i>
      </button>
    </div>
  `;
}

function renderHerdrTabButton(tab: HerdrTabInfo): string {
  const number = String(tab.number || "").trim();
  const rawLabel = tab.label.trim() || `Tab ${number}`.trim();
  const label = compactHerdrTabLabel(rawLabel, number);
  return `
    <button class="herdr-tab ${label ? "" : "number-only"}" type="button" role="tab" data-herdr-tab="${escapeAttr(tab.tab_id)}" aria-selected="${tab.focused}" title="${escapeAttr(tab.tab_id)}">
      ${number ? `<small>${escapeHtml(number)}</small>` : ""}
      ${label ? `<span>${escapeHtml(label)}</span>` : ""}
    </button>
  `;
}

function compactHerdrTabLabel(label: string, number: string): string {
  if (!number) return label;
  if (label === number) return "";
  return label.replace(new RegExp(`^${escapeRegExp(number)}(?:[.\\s:-]+)`), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function focusedHerdrWorkspace(): HerdrWorkspaceInfo | undefined {
  return herdrState?.workspaces.find((workspace) => workspace.focused) ?? herdrState?.workspaces[0];
}

type ApplyWorkspaceOptions = {
  generation?: number;
  preferStateActiveTab?: boolean;
  replayFromStart?: boolean;
  selector?: string;
};

async function applyWorkspaceState(workspace: WorkspaceState, options: ApplyWorkspaceOptions = {}): Promise<boolean> {
  const responseSelector = normalizeSelector(workspace.selector);
  const expectedSelector = normalizeSelector(options.selector ?? selectedSelector);
  if (responseSelector && expectedSelector && responseSelector !== expectedSelector) {
    throw new Error(`Workspace selector mismatch: expected ${expectedSelector}, got ${responseSelector}`);
  }
  const workspaceSelector = responseSelector || expectedSelector;
  if (!workspaceSelector) return false;
  if (options.generation !== undefined && !isCurrentSelectorRequest(workspaceSelector, options.generation)) {
    return false;
  }
  setSelectedSelector(workspaceSelector, { updateLocation: false });
  const existingPanes = new Map(allPanes().map((pane) => [pane.id, pane]));
  const retainedPaneIds = new Set<string>();
  tabs = [];
  const requestedTabId = requestedTabIdFromLocation();
  const rememberedTabId = readRememberedTabId(workspaceSelector);
  const stateActiveTabId = workspace.active_tab_id;
  const preferredTabIds = options.preferStateActiveTab
    ? [stateActiveTabId, requestedTabId, rememberedTabId]
    : [requestedTabId, rememberedTabId, stateActiveTabId];
  activeTabId = undefined;
  elements.terminalStage.replaceChildren();
  for (const tabState of workspace.tabs) {
    const tab = makeTab(workspaceSelector, tabState.id);
    tab.customTitle = tabState.custom_label?.trim() || undefined;
    tab.activePaneId = tabState.active_pane_id;
    tab.layout = tabState.layout;
    tabs = [...tabs, tab];
    elements.terminalStage.appendChild(tab.mount);
    for (const paneState of tabState.panes) {
      const pane = await restoreWorkspacePane(tab, paneState, existingPanes.get(paneState.id), options);
      retainedPaneIds.add(pane.id);
    }
    if (!tab.activePaneId) {
      tab.activePaneId = tab.panes[0]?.id;
    }
    if (!tab.layout && tab.panes.length) {
      tab.layout = paneLayoutNode(tab.panes[0].id);
    }
    renderPaneLayout(tab);
  }
  activeTabId = firstExistingTabId(preferredTabIds);
  if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
    activeTabId = tabs[0]?.id;
  }
  if (activeTabId) {
    activateTab(activeTabId, { sync: false });
  } else {
    renderTabs();
    updateActiveDetails();
  }
  for (const [paneId, pane] of existingPanes) {
    if (!retainedPaneIds.has(paneId)) {
      disposePaneLocal(pane);
    }
  }
  await nextAnimationFrame();
  connectWorkspacePanes();
  scheduleTerminalSizeRefresh();
  return true;
}

async function restoreWorkspacePane(
  tab: TerminalTab,
  paneState: WorkspacePaneState,
  existing?: TerminalPane,
  options: ApplyWorkspaceOptions = {},
): Promise<TerminalPane> {
  const pane = existing ?? makePane(tab, paneState.id);
  if (existing && options.replayFromStart) {
    preparePaneForFullReplay(pane);
  }
  pane.tabId = tab.id;
  pane.selector = tab.selector;
  pane.label = tab.label;
  pane.sessionId = paneState.session_id;
  pane.sessionStatus = paneState.status;
  pane.sessionBackend = normalizeSessionMode(paneState.session_backend);
  pane.cols = paneState.cols || INITIAL_COLS;
  pane.rows = paneState.rows || INITIAL_ROWS;
  pane.exited = paneState.status === "exited";
  pane.closing = false;
  tab.panes.push(pane);
  renderPaneLayout(tab);
  if (!pane.term) {
    setPaneStatus(pane, tr("status.loadingGhostty"));
    await mountTerminal(pane);
  }
  if (!shouldConnectRestoredPane(pane)) {
    setPaneStatus(pane, tr("status.sessionStopped"), "neutral");
  } else if (pane.socket?.readyState !== WebSocket.OPEN && pane.socket?.readyState !== WebSocket.CONNECTING) {
    setPaneStatus(pane, tr("status.loadingGhostty"));
  }
  return pane;
}

function preparePaneForFullReplay(pane: TerminalPane) {
  window.clearTimeout(pane.reconnectTimer);
  clearReplayInputLock(pane);
  pane.transport?.disconnect();
  flushPaneDecoder(pane);
  pane.term?.dispose();
  pane.term = undefined;
  pane.socket = undefined;
  pane.lastOutputSequence = 0;
  pane.titleBuffer = "";
  clearPendingInput(pane);
}

function shouldConnectRestoredPane(pane: TerminalPane): boolean {
  if (!pane.sessionId || pane.sessionStatus === "exited") return false;
  if (pane.sessionStatus === "running" || pane.sessionStatus === "starting") return true;
  if (pane.sessionStatus === "stopped") return true;
  return settings.autoRestartSessions;
}

async function connectRestoredPanes() {
  for (const pane of allPanes()) {
    if (pane.closing || pane.exited || !pane.sessionId) continue;
    if (pane.socket?.readyState === WebSocket.OPEN || pane.socket?.readyState === WebSocket.CONNECTING) continue;
    if (!shouldConnectRestoredPane(pane)) {
      setPaneStatus(pane, tr("status.sessionStopped"), "neutral");
      continue;
    }
    setPaneStatus(pane, tr("status.loadingGhostty"));
    if (!pane.term) {
      await mountTerminal(pane);
    }
    connectPanePty(pane);
  }
}

function connectWorkspacePanes() {
  for (const pane of allPanes()) {
    if (!shouldConnectRestoredPane(pane)) {
      if (!pane.exited) {
        setPaneStatus(pane, tr("status.sessionStopped"), "neutral");
      }
      continue;
    }
    if (pane.socket?.readyState === WebSocket.OPEN || pane.socket?.readyState === WebSocket.CONNECTING) {
      continue;
    }
    setPaneStatus(pane, tr("status.loadingGhostty"));
    connectPanePty(pane);
  }
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => resolve());
  });
}

async function createSelectedTab(mode?: SessionMode) {
  if (!selectedSelector) {
    setGlobalStatus(tr("status.selectRunningInstance"), "error");
    return;
  }
  await createTerminalTab(selectedSelector, mode);
}

async function createTerminalTab(selector: string, requestedMode?: SessionMode) {
  const mode = requestedMode && sessionBackendIsSelectable(requestedMode)
    ? requestedMode
    : preferredBackendForNewTab();
  try {
    if (mode === "herdr") {
      const existing = findPaneBySessionBackend(selector, "herdr");
      if (existing) {
        activatePane(existing.tab.id, existing.pane.id);
        const ready = herdrState?.available || await refreshHerdrState(selector);
        if (!ready) {
          setGlobalStatus(tr("status.herdrUnavailable"), "error");
          return;
        }
        await runHerdrAction("create_workspace");
        await syncHerdrEventBridge({ force: true });
        return;
      }
    }
    await runWorkspaceAction("create_tab", { selector, sessionBackend: mode });
    if (mode === "herdr") {
      window.setTimeout(() => void refreshHerdrState(selector), 400);
    }
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

function preferredBackendForNewTab(): SessionMode {
  const preferred = normalizeSessionMode(settings.defaultSessionBackend);
  if (!sessionBackendIsSelectable(preferred)) return "webshell";
  return preferred;
}

function makeTab(selector: string, restoredId?: string): TerminalTab {
  const id = restoredId || newId();
  const mount = document.createElement("div");
  mount.className = "tab-mount";
  mount.dataset.tabId = id;
  mount.setAttribute("role", "tabpanel");
  mount.setAttribute("aria-label", selector);
  return {
    id,
    selector,
    label: selectorLabel(selector),
    mount,
    panes: [],
    closing: false,
  };
}

function makePane(tab: TerminalTab, restoredId?: string): TerminalPane {
  const id = restoredId || newId();
  const mount = document.createElement("div");
  mount.className = "terminal-mount";
  mount.dataset.paneId = id;
  mount.tabIndex = 0;
  mount.setAttribute("role", "group");
  mount.setAttribute("aria-label", `${tab.label} pane`);
  mount.addEventListener("pointerdown", (event) => {
    const current = findPaneById(id);
    if (current) {
      trackMobileTerminalSwipeStart(current, event);
      activatePane(current.tabId, id, { focus: false });
      if (shouldFocusTerminalFromPointer(event)) {
        requestAnimationFrame(() => focusPaneCanvas(current));
      }
    }
  });
  mount.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "touch") return;
    const current = findPaneById(id);
    const gesture = current ? readMobileTerminalGesture(current, event) : undefined;
    if (current && gesture && runMobileTerminalSwipe(gesture)) {
      clearMobileTerminalGesture();
      event.preventDefault();
      return;
    }
    clearMobileTerminalGesture();
    if (current && gesture && isMobileTerminalTapGesture(gesture) && isDoubleTerminalTap(current, event)) {
      event.preventDefault();
      focusPaneSystemKeyboard(current);
    }
  });
  mount.addEventListener("pointercancel", (event) => {
    if (event.pointerType === "touch" && mobileTerminalSwipe.paneId === id) {
      clearMobileTerminalGesture();
    }
  });
  mount.addEventListener("dblclick", (event) => {
    event.preventDefault();
    const current = findPaneById(id);
    if (current) {
      focusPaneSystemKeyboard(current);
    }
  });
  mount.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const current = findPaneById(id);
    if (!current) return;
    activatePane(current.tabId, id);
    openPaneMenu(event.clientX, event.clientY, id);
  });
  const pane: TerminalPane = {
    id,
    tabId: tab.id,
    selector: tab.selector,
    label: tab.label,
    title: tab.label,
    status: tr("status.idle"),
    tone: "neutral",
    mount,
    reconnectDelay: 1000,
    pendingInput: [],
    pendingInputBytes: 0,
    replaying: false,
    lastOutputSequence: 0,
    aiContextText: "",
    exited: false,
    closing: false,
    titleBuffer: "",
    sessionBackend: "webshell",
    workingDirectory: "",
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
  };
  pane.transport = createPaneTransport(pane);
  mount.addEventListener("mouseup", () => {
    if (settings.copyOnSelect) {
      scheduleCopySelection();
    }
  });
  mount.addEventListener("touchend", () => {
    if (settings.copyOnSelect) {
      scheduleCopySelection();
    }
  });
  applyThemeToMount(mount);
  return pane;
}

function createPaneTransport(pane: TerminalPane): PaneTerminalTransport {
  let callbacks: Parameters<PaneTerminalTransport["connect"]>[0]["callbacks"] | undefined;
  let connected = false;

  return {
    connect: (options) => {
      callbacks = options.callbacks;
      if (pane.closing) return;
      if (options.cols && options.rows) {
        updatePaneTerminalSize(pane, options.cols, options.rows);
      }
      if (pane.socket?.readyState === WebSocket.OPEN) {
        connected = true;
        callbacks.onConnect?.();
        return;
      }
      if (pane.socket?.readyState === WebSocket.CONNECTING) return;
      openSocket(pane);
    },
    disconnect: () => {
      connected = false;
      pane.socket?.close();
      pane.socket = undefined;
    },
    sendInput: (data) => sendPaneInput(pane, data),
    resize: (cols, rows) => sendPaneResize(pane, cols, rows),
    isConnected: () => connected && pane.socket?.readyState === WebSocket.OPEN && !pane.closing && !pane.exited,
    destroy: () => {
      connected = false;
      callbacks = undefined;
      pane.socket?.close();
      pane.socket = undefined;
    },
    notifyConnect: () => {
      connected = true;
      callbacks?.onConnect?.();
    },
    notifyDisconnect: () => {
      connected = false;
      callbacks?.onDisconnect?.();
    },
    notifyData: (data) => {
      if (!data) return false;
      if (!callbacks?.onData) return false;
      callbacks.onData(data);
      return true;
    },
    notifyError: (message, errors) => {
      callbacks?.onError?.(message, errors);
    },
    notifyExit: (code) => {
      callbacks?.onExit?.(code);
    },
  };
}

async function createPane(tab: TerminalTab, placement: SplitPlacement) {
  const pane = activePane(tab);
  if (pane?.sessionBackend === "herdr") {
    try {
      await splitHerdrPane(pane, placement);
    } catch (error) {
      setGlobalStatus(tr("status.herdrActionFailed", { message: errorMessage(error) }), "error");
    }
    return;
  }
  if (pane?.sessionBackend === "zellij") {
    splitZellijPane(pane, placement);
    return;
  }
  if (!pane || pane.sessionBackend !== "webshell") {
    if (pane) setBackendActionUnavailable(pane);
    return;
  }
  try {
    await runWorkspaceAction("split_pane", {
      selector: tab.selector,
      tabId: tab.id,
      paneId: pane.id,
      direction: placement,
      sessionBackend: "webshell",
    });
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function splitActivePane(placement: SplitPlacement) {
  const tab = activeTab();
  if (!tab) {
    await createSelectedTab();
    return;
  }
  await createPane(tab, placement);
}

function renderPaneLayout(tab: TerminalTab) {
  tab.mount.replaceChildren();
  if (tab.layout) {
    tab.mount.appendChild(renderSplitNode(tab, tab.layout));
  }
  updatePaneActiveState(tab);
}

function renderSplitNode(tab: TerminalTab, node: SplitNode): HTMLElement {
  if (node.type === "pane") {
    const pane = tab.panes.find((item) => item.id === node.paneId);
    return pane?.mount ?? missingPaneElement(node.paneId);
  }

  const container = document.createElement("div");
  container.className = "split-container";
  container.dataset.splitAxis = node.axis;
  container.style.setProperty("--split-count", String(Math.max(1, node.children.length)));
  for (const child of node.children) {
    container.appendChild(renderSplitNode(tab, child));
  }
  return container;
}

function missingPaneElement(paneId: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "terminal-mount missing-pane";
  element.dataset.paneId = paneId;
  return element;
}

function updatePaneActiveState(tab: TerminalTab) {
  for (const pane of tab.panes) {
    pane.mount.classList.toggle("active-pane", pane.id === tab.activePaneId);
  }
}

async function mountTerminal(pane: TerminalPane) {
  pane.term?.dispose();
  pane.mount.innerHTML = "";
  applyThemeToMount(pane.mount);
  pane.decoder = new TextDecoder();

  const term = new Terminal({
    cols: pane.cols || INITIAL_COLS,
    rows: pane.rows || INITIAL_ROWS,
    createInitialPane: true,
    shortcuts: false,
    defaultContextMenu: false,
    paneStyles: {
      enabled: true,
      splitBackground: "var(--term-bg, #050a12)",
      paneBackground: "var(--term-bg, #050a12)",
      inactivePaneOpacity: 1,
      activePaneOpacity: 1,
      opacityTransitionMs: 0,
      dividerThicknessPx: 0,
    },
    searchUi: false,
    fontSources: resttyFontSourcesFor(currentFont()),
    appOptions: {
      renderer: "auto",
      fontPreset: "none",
      fontSize: settings.fontSize,
      ligatures: true,
      autoResize: true,
      attachWindowEvents: true,
      attachCanvasEvents: true,
      touchSelectionMode: settings.touchSelectionMode,
      touchSelectionLongPressMs: 450,
      touchSelectionMoveThresholdPx: 10,
      beforeInput: ({ text, source }) => transformMobileStickyInput(text, source),
      maxScrollbackBytes: Math.max(1_000_000, settings.scrollbackLimit * 160),
      ptyTransport: pane.transport,
      callbacks: {
        onGridSize: (cols, rows) => {
          handleTerminalResize(pane, cols, rows);
          applyCursorAppearance(pane);
        },
      },
    },
  });
  if (pane.closing) return;
  pane.term = term;
  term.open(pane.mount);
  term.restty?.setMouseMode(pane.sessionBackend === "herdr" ? "off" : "auto");
  installPaneScrollbackFallback(pane);
  installPaneTouchKeyboardGuard(pane);
  installPaneViewportGuard(pane);
  schedulePaneViewportReset(pane);
  applyTerminalAppearance(pane);
  if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
    term.focus();
  }
}

function handleTerminalResize(pane: TerminalPane, cols: number, rows: number) {
  updatePaneTerminalSize(pane, cols, rows);
  updateActiveDetails();
}

function updatePaneTerminalSize(pane: TerminalPane, cols: number, rows: number): boolean {
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return false;
  const nextCols = Math.max(1, Math.trunc(cols));
  const nextRows = Math.max(1, Math.trunc(rows));
  if (pane.cols === nextCols && pane.rows === nextRows) return false;
  pane.cols = nextCols;
  pane.rows = nextRows;
  if (pane.term) {
    pane.term.cols = nextCols;
    pane.term.rows = nextRows;
  }
  return true;
}

function sendPaneResize(pane: TerminalPane, cols: number, rows: number): boolean {
  updatePaneTerminalSize(pane, cols, rows);
  if (pane.socket?.readyState === WebSocket.OPEN) {
    pane.socket.send(JSON.stringify({ type: "resize", cols: pane.cols, rows: pane.rows }));
    updateActiveDetails();
    return true;
  }
  return false;
}

function connectPanePty(pane: TerminalPane) {
  if (pane.closing || pane.exited || !pane.sessionId) return;
  const restty = pane.term?.restty;
  if (restty) {
    restty.connectPty("");
    return;
  }
  openSocket(pane);
}

function openSocket(pane: TerminalPane) {
  if (!pane.sessionId) return;
  if (pane.socket?.readyState === WebSocket.OPEN || pane.socket?.readyState === WebSocket.CONNECTING) return;
  const url = new URL("./ws/terminal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("session_id", pane.sessionId);
  url.searchParams.set("pane_id", pane.id);
  url.searchParams.set("cols", String(pane.cols || pane.term?.cols || INITIAL_COLS));
  url.searchParams.set("rows", String(pane.rows || pane.term?.rows || INITIAL_ROWS));
  url.searchParams.set("restart", String(settings.autoRestartSessions));
  url.searchParams.set("replay", "true");
  url.searchParams.set("after", String(pane.lastOutputSequence));
  url.searchParams.set("output_limit", String(settings.outputBufferLimit));

  pane.exited = false;
  pane.replaying = true;
  pane.decoder = new TextDecoder();
  const socket = new WebSocket(url);
  pane.socket = socket;
  socket.binaryType = "arraybuffer";
  socket.addEventListener("open", () => {
    if (pane.socket !== socket) return;
    pane.reconnectDelay = 1000;
    beginReplayInputLock(pane, socket);
    pane.transport?.notifyConnect();
    sendRestartPolicy(pane);
    sendOutputBufferLimit(pane);
    setPaneStatus(pane, tr("status.connected"), "ok");
    if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
      pane.term?.focus();
    }
  });
  socket.addEventListener("message", (event) => {
    if (pane.socket === socket) handleSocketMessage(pane, event);
  });
  socket.addEventListener("close", () => {
    if (pane.socket !== socket) return;
    clearReplayInputLock(pane);
    flushPaneDecoder(pane);
    pane.transport?.notifyDisconnect();
    scheduleReconnect(pane);
  });
  socket.addEventListener("error", () => {
    if (pane.socket !== socket) return;
    clearReplayInputLock(pane);
    pane.transport?.notifyError(tr("status.socketError"));
    setPaneStatus(pane, tr("status.socketError"), "error");
  });
}

function beginReplayInputLock(pane: TerminalPane, socket: WebSocket) {
  window.clearTimeout(pane.replayTimer);
  pane.replaying = true;
  pane.replayTimer = window.setTimeout(() => {
    if (pane.socket !== socket || pane.closing || !pane.replaying) return;
    finishReplayInputLock(pane);
  }, REPLAY_INPUT_LOCK_TIMEOUT_MS);
}

function clearReplayInputLock(pane: TerminalPane) {
  window.clearTimeout(pane.replayTimer);
  pane.replayTimer = undefined;
  pane.replaying = false;
}

function finishReplayInputLock(pane: TerminalPane) {
  clearReplayInputLock(pane);
  applyCursorAppearance(pane);
  flushPendingInput(pane);
}

function syncRestartPolicyToServer() {
  for (const pane of allPanes()) {
    sendRestartPolicy(pane);
  }
}

function syncOutputBufferLimitToServer() {
  for (const pane of allPanes()) {
    sendOutputBufferLimit(pane);
  }
}

function sendOutputBufferLimit(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN) return;
  pane.socket.send(JSON.stringify({ type: "output-buffer", limit: settings.outputBufferLimit }));
}

function sendRestartPolicy(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN) return;
  pane.socket.send(JSON.stringify({ type: "restart-policy", enabled: settings.autoRestartSessions }));
}

function handleSocketMessage(pane: TerminalPane, event: MessageEvent) {
  if (pane.closing) return;
  if (event.data instanceof ArrayBuffer) {
    writeTerminalBytes(pane, new Uint8Array(event.data));
    return;
  }
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then((buffer) => {
      if (!pane.closing) writeTerminalBytes(pane, new Uint8Array(buffer));
    });
    return;
  }
  handleServerText(pane, String(event.data));
}

function handleServerText(pane: TerminalPane, text: string) {
  const event = parseTerminalServerMessage(text);
  if (!event) {
    writeTerminalText(pane, text);
    return;
  }
  if (event.type === "ready") {
    pane.sessionStatus = "running";
    pane.exited = false;
    setPaneStatus(pane, tr("status.shellReady"), "ok");
  } else if (event.type === "replay-start") {
    if (!matchesPaneReplay(pane, event)) {
      clearReplayInputLock(pane);
      pane.socket?.close();
      setPaneStatus(pane, tr("status.terminalError"), "error");
      return;
    }
    pane.replaying = true;
  } else if (event.type === "error") {
    clearReplayInputLock(pane);
    pane.transport?.notifyError(event.message ?? tr("status.terminalError"));
    setPaneStatus(pane, event.message ?? tr("status.terminalError"), "error");
    if (event.fatal) {
      pane.exited = true;
      pane.sessionStatus = "stopped";
      clearPendingInput(pane);
    }
  } else if (event.type === "process-exit") {
    clearReplayInputLock(pane);
    pane.exited = true;
    clearPendingInput(pane);
    pane.sessionStatus = "exited";
    pane.transport?.notifyExit(event.exit_code ?? -1);
    setPaneStatus(pane, tr("status.processExited", { code: event.exit_code ?? -1 }), "error");
  } else if (event.type === "session-stopped") {
    clearReplayInputLock(pane);
    clearPendingInput(pane);
    pane.sessionStatus = "stopped";
    setPaneStatus(pane, event.message || tr("status.sessionStopped"), "neutral");
  } else if (event.type === "output-sequence") {
    pane.lastOutputSequence = monotonicSequence(pane.lastOutputSequence, event.sequence);
  } else if (event.type === "replay-complete") {
    if (!matchesPaneReplay(pane, event)) {
      clearReplayInputLock(pane);
      pane.socket?.close();
      setPaneStatus(pane, tr("status.terminalError"), "error");
      return;
    }
    pane.lastOutputSequence = monotonicSequence(pane.lastOutputSequence, event.last_sequence);
    finishReplayInputLock(pane);
  }
}

function matchesPaneReplay(pane: TerminalPane, event: { session_id?: string; pane_id?: string }): boolean {
  if (event.session_id && event.session_id !== pane.sessionId) return false;
  if (event.pane_id && event.pane_id !== pane.id) return false;
  return true;
}

function writeTerminalBytes(pane: TerminalPane, bytes: Uint8Array) {
  const decoder = pane.decoder ??= new TextDecoder();
  const text = decoder.decode(bytes, { stream: true });
  if (text) writeTerminalText(pane, text);
}

function flushPaneDecoder(pane: TerminalPane) {
  const text = pane.decoder?.decode();
  if (text) writeTerminalText(pane, text);
  pane.decoder = undefined;
}

function writeTerminalText(pane: TerminalPane, text: string) {
  appendAIContext(pane, text);
  observeTerminalTitle(pane, text);
  if (!pane.transport?.notifyData(text)) {
    pane.term?.write(text);
  }
}

function observeTerminalTitle(pane: TerminalPane, text: string) {
  pane.titleBuffer = `${pane.titleBuffer}${text}`.slice(-4096);
  const pattern = /\x1b\](?:0|2);([\s\S]*?)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let title: string | undefined;
  while ((match = pattern.exec(pane.titleBuffer)) !== null) {
    title = match[1]?.replace(/[\x00-\x1f\x7f]/g, "").trim();
  }
  if (title) updatePaneTitle(pane, title);
}

function scheduleReconnect(pane: TerminalPane) {
  if (pane.closing || pane.exited || !pane.sessionId) return;
  if (pane.sessionStatus !== "running" && !settings.autoRestartSessions) {
    setPaneStatus(pane, tr("status.sessionStopped"), "neutral");
    return;
  }
  window.clearTimeout(pane.reconnectTimer);
  const delay = pane.reconnectDelay;
  pane.reconnectDelay = Math.min(pane.reconnectDelay * 2, 30000);
  setPaneStatus(pane, tr("status.reconnecting", { seconds: Math.round(delay / 1000) }), "error");
  pane.reconnectTimer = window.setTimeout(() => connectPanePty(pane), delay);
}

function scheduleTerminalSizeRefresh() {
  for (const timer of terminalResizeTimers) {
    window.clearTimeout(timer);
  }
  terminalResizeTimers = TERMINAL_SIZE_REFRESH_DELAYS_MS.map((delay) => (
    window.setTimeout(refreshTerminalSizes, delay)
  ));
}

function refreshTerminalSizes() {
  for (const pane of allPanes()) {
    refreshPaneTerminalSize(pane);
  }
}

function refreshPaneTerminalSize(pane: TerminalPane) {
  resetPaneViewport(pane);
  pane.term?.restty?.updateSize(true);
  const cols = pane.term?.cols ?? pane.cols;
  const rows = pane.term?.rows ?? pane.rows;
  if (pane.socket?.readyState === WebSocket.OPEN && Number.isFinite(cols) && Number.isFinite(rows)) {
    sendPaneResize(pane, cols, rows);
  }
}

function installPaneViewportGuard(pane: TerminalPane) {
  if (pane.viewportGuardInstalled) return;
  const resetAndResize = () => {
    schedulePaneViewportReset(pane);
    scheduleTerminalSizeRefresh();
  };
  const resetOnly = () => schedulePaneViewportReset(pane);
  pane.mount.addEventListener("beforeinput", resetAndResize, true);
  pane.mount.addEventListener("input", resetAndResize, true);
  pane.mount.addEventListener("compositionstart", resetAndResize, true);
  pane.mount.addEventListener("compositionupdate", resetAndResize, true);
  pane.mount.addEventListener("compositionend", resetAndResize, true);
  pane.mount.addEventListener("scroll", resetOnly, true);
  pane.mount.addEventListener("blur", resetAndResize, true);
  pane.viewportGuardInstalled = true;
}

function installPaneScrollbackFallback(pane: TerminalPane) {
  if (pane.scrollbackFallbackInstalled) return;
  let touchPointerId: number | undefined;
  let lastTouchY = 0;
  let touchScrollActive = false;

  const stopTouchScroll = (pointerId: number) => {
    if (touchPointerId !== pointerId) return;
    touchPointerId = undefined;
    touchScrollActive = false;
  };

  pane.mount.addEventListener("wheel", (event) => {
    if (pane.sessionBackend === "herdr") return;
    if (paneMouseReportingActive(pane, event)) return;
    const host = paneScrollbackHost(pane);
    if (!host || !hostCanScroll(host)) return;
    if (scrollPaneHost(host, normalizedWheelDeltaPx(event, host))) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointerdown", (event) => {
    if (paneMouseReportingActive(pane, event)) return;
    if (event.pointerType !== "touch" || !paneTouchScrollbackFallbackEnabled(pane)) return;
    const host = paneScrollbackHost(pane);
    if (!host || !hostCanScroll(host)) return;
    touchPointerId = event.pointerId;
    lastTouchY = event.clientY;
    touchScrollActive = false;
    if (pane.sessionBackend === "herdr") {
      trackMobileTerminalSwipeStart(pane, event);
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointermove", (event) => {
    if (paneMouseReportingActive(pane, event)) return;
    if (touchPointerId !== event.pointerId || !paneTouchScrollbackFallbackEnabled(pane)) return;
    const host = paneScrollbackHost(pane);
    if (!host || !hostCanScroll(host)) return;
    const deltaPx = lastTouchY - event.clientY;
    if (!touchScrollActive && Math.abs(deltaPx) < 6) return;
    touchScrollActive = true;
    lastTouchY = event.clientY;
    if (scrollPaneHost(host, deltaPx)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointerup", (event) => stopTouchScroll(event.pointerId), true);
  pane.mount.addEventListener("pointercancel", (event) => stopTouchScroll(event.pointerId), true);
  pane.mount.addEventListener("lostpointercapture", (event) => stopTouchScroll(event.pointerId), true);
  pane.scrollbackFallbackInstalled = true;
}

function installPaneTouchKeyboardGuard(pane: TerminalPane) {
  if (pane.touchKeyboardGuardInstalled) return;
  let touchPointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let suppressInput: HTMLTextAreaElement | null = null;
  let suppressInputReadOnly = false;
  let scrollLocked = false;

  const restoreInput = () => {
    if (!suppressInput) return;
    suppressInput.readOnly = suppressInputReadOnly;
    suppressInput = null;
  };

  const stopTouch = (pointerId: number) => {
    if (touchPointerId !== pointerId) return;
    touchPointerId = undefined;
    scrollLocked = false;
    restoreInput();
  };

  pane.mount.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "touch") return;
    touchPointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    scrollLocked = false;
    suppressInput = paneImeInput(pane);
    if (suppressInput) {
      suppressInputReadOnly = suppressInput.readOnly;
      suppressInput.readOnly = true;
    }
  }, { capture: true, passive: true });

  pane.mount.addEventListener("pointermove", (event) => {
    if (touchPointerId !== event.pointerId || scrollLocked) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (Math.hypot(dx, dy) < MOBILE_TERMINAL_SCROLL_LOCK_THRESHOLD_PX) return;
    if (absDy < absDx * MOBILE_TERMINAL_SCROLL_AXIS_RATIO) return;
    scrollLocked = true;
    pane.term?.blur();
    restoreInput();
    handleViewportChange();
  }, { capture: true, passive: true });

  pane.mount.addEventListener("pointerup", (event) => stopTouch(event.pointerId), true);
  pane.mount.addEventListener("pointercancel", (event) => stopTouch(event.pointerId), true);
  pane.mount.addEventListener("lostpointercapture", (event) => stopTouch(event.pointerId), true);
  pane.touchKeyboardGuardInstalled = true;
}

function paneScrollbackHost(pane: TerminalPane): HTMLElement | null {
  return pane.mount.querySelector<HTMLElement>(".restty-native-scroll-host");
}

function paneTouchScrollbackFallbackEnabled(pane: TerminalPane): boolean {
  return pane.sessionBackend === "herdr" || settings.touchSelectionMode !== "drag";
}

function paneMouseReportingActive(pane: TerminalPane, event: MouseEvent | PointerEvent): boolean {
  if (event.shiftKey) return false;
  return Boolean(pane.term?.restty?.getMouseStatus().active);
}

function hostCanScroll(host: HTMLElement): boolean {
  return host.scrollHeight > host.clientHeight + 1;
}

function normalizedWheelDeltaPx(event: WheelEvent, host: HTMLElement): number {
  if (event.deltaMode === 1) return event.deltaY * 40;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, host.clientHeight);
  return event.deltaY;
}

function scrollPaneHost(host: HTMLElement, deltaPx: number): boolean {
  if (!Number.isFinite(deltaPx) || !deltaPx) return false;
  const before = host.scrollTop;
  host.scrollTop += deltaPx;
  return Math.abs(host.scrollTop - before) > 0.5;
}

function schedulePaneViewportReset(pane: TerminalPane) {
  resetPaneViewport(pane);
  window.requestAnimationFrame(() => resetPaneViewport(pane));
}

function resetPaneViewport(pane: TerminalPane) {
  const hosts = [
    ...pane.mount.querySelectorAll<HTMLElement>("textarea, [contenteditable='true']"),
  ];
  for (const host of hosts) {
    if (host.scrollTop !== 0) host.scrollTop = 0;
    if (host.scrollLeft !== 0) host.scrollLeft = 0;
  }
}

async function remountTerminalsForTouchMode() {
  for (const pane of allPanes()) {
    if (pane.closing || !pane.term) continue;
    const shouldReconnect = shouldConnectRestoredPane(pane);
    pane.transport?.disconnect();
    await mountTerminal(pane);
    if (shouldReconnect) {
      connectPanePty(pane);
    }
  }
}

function activateTab(tabId: string, options: { sync?: boolean; updateLocation?: boolean } = {}) {
  activeTabId = tabId;
  for (const tab of tabs) {
    const active = tab.id === tabId;
    tab.mount.classList.toggle("active", active);
    tab.mount.setAttribute("aria-hidden", active ? "false" : "true");
  }
  renderTabs();
  updateActiveDetails();
  renderHerdrDock();
  activePane()?.term?.focus();
  if (options.updateLocation !== false) {
    rememberActiveTab();
  }
  if (options.sync !== false) {
    const tab = tabs.find((item) => item.id === tabId);
    void runWorkspaceAction("activate_tab", { selector: tab?.selector, tabId, apply: false }).catch(() => undefined);
  }
}

function activateAdjacentTab(direction: -1 | 1) {
  if (!tabs.length || !activeTabId) return;
  const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
  const next = tabs[(index + direction + tabs.length) % tabs.length];
  if (next) {
    activateTab(next.id);
  }
}

function activatePane(tabId: string, paneId: string, options: { focus?: boolean; sync?: boolean } = {}) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  activeTabId = tabId;
  tab.activePaneId = paneId;
  updatePaneActiveState(tab);
  renderTabs();
  updateActiveDetails();
  renderHerdrDock();
  if (options.focus !== false) {
    activePane(tab)?.term?.focus();
  }
  if (options.sync !== false) {
    void runWorkspaceAction("activate_pane", { selector: tab.selector, tabId, paneId, apply: false }).catch(() => undefined);
  }
}

function activateAdjacentPane(direction: -1 | 1) {
  const tab = activeTab();
  if (!tab) return;
  const panes = visiblePanes(tab);
  if (!panes.length) return;
  const pane = activePane(tab);
  const index = Math.max(0, panes.findIndex((item) => item.id === pane?.id));
  const next = panes[(index + direction + panes.length) % panes.length];
  if (next) {
    activatePane(tab.id, next.id);
  }
}

function renderTabs() {
  updateTabChrome();
  if (!tabs.length) {
    elements.tabList.innerHTML = `<div class="empty-tab">${escapeHtml(tr("status.noSessions"))}</div>`;
    updateIcons();
    return;
  }
  elements.tabList.innerHTML = tabs.map((tab) => {
    const active = tab.id === activeTabId;
    const renaming = renamingTabId === tab.id;
    const displayName = tabDisplayName(tab);
    const named = tabHasTextTitle(tab, displayName);
    const title = tabCurrentTitle(tab);
    const label = renaming
      ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(displayName)}" aria-label="${escapeAttr(tr("action.renameTab"))}" spellcheck="false" />`
      : `<span class="tab-title">${escapeHtml(displayName)}</span>`;
    return `
      <div class="tab ${active ? "active" : ""} ${named ? "named" : ""}">
        <div class="tab-main" id="tab-${escapeAttr(tab.id)}" role="tab" tabindex="0" aria-selected="${active}" data-tab-id="${escapeAttr(tab.id)}" title="${escapeAttr(title)}">
          <span class="tab-status" data-tone="${tabTone(tab)}"></span>
          ${label}
        </div>
        <button class="tab-close" data-close-tab="${escapeAttr(tab.id)}" type="button" aria-label="${escapeAttr(tr("action.closeTab"))}" title="${escapeAttr(tr("action.closeTab"))}">
          <i data-lucide="x"></i>
        </button>
      </div>
    `;
  }).join("");
  elements.tabList.querySelectorAll<HTMLElement>(".tab-main[data-tab-id]").forEach((button) => {
    button.addEventListener("click", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      activateTab(button.dataset.tabId ?? "");
    });
    button.addEventListener("dblclick", (event) => {
      event.preventDefault();
      startRenamingTab(button.dataset.tabId ?? "");
    });
    button.addEventListener("keydown", (event) => {
      if (event.target instanceof HTMLInputElement) return;
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTab(button.dataset.tabId ?? "");
      } else if (event.key === "F2") {
        event.preventDefault();
        startRenamingTab(button.dataset.tabId ?? "");
      }
    });
  });
  elements.tabList.querySelectorAll<HTMLInputElement>(".tab-rename[data-rename-tab]").forEach((input) => {
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void commitTabRename(input.dataset.renameTab ?? "", input.value);
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancelTabRename();
      }
    });
    input.addEventListener("blur", () => void commitTabRename(input.dataset.renameTab ?? "", input.value));
  });
  elements.tabList.querySelectorAll<HTMLElement>("[data-close-tab]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      void requestCloseTab(button.dataset.closeTab ?? "");
    });
    button.addEventListener("auxclick", (event) => event.stopPropagation());
  });
  elements.tabList.querySelectorAll<HTMLElement>(".tab").forEach((tabElement) => {
    tabElement.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const tabId = tabElement.querySelector<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      if (tabId) void requestCloseTab(tabId);
    });
  });
  updateIcons();
  focusRenameInput();
}

function updateTabChrome() {
  elements.webshell.classList.toggle("has-named-tabs", tabs.some((tab) => tabHasTextTitle(tab, tabDisplayName(tab))));
}

function tabDisplayName(tab: TerminalTab): string {
  return (isHerdrTab(tab) ? herdrWorkspaceLabelForTab(tab) : "")
    || tab.customTitle?.trim()
    || herdrWorkspaceLabelForTab(tab)
    || String(tabs.findIndex((item) => item.id === tab.id) + 1);
}

function tabHasTextTitle(tab: TerminalTab, displayName = tabDisplayName(tab)): boolean {
  return Boolean(tab.customTitle?.trim()) || !/^\d+$/.test(displayName.trim());
}

function herdrWorkspaceLabelForTab(tab: TerminalTab): string {
  if (!isHerdrTab(tab)) return "";
  if (normalizeSelector(herdrState?.selector) !== normalizeSelector(tab.selector)) {
    return tr("backend.herdr");
  }
  const workspace = focusedHerdrWorkspace();
  return workspace?.label.trim() || tr("backend.herdr");
}

function isHerdrTab(tab: TerminalTab): boolean {
  return tab.panes.some((pane) => pane.sessionBackend === "herdr");
}

function startRenamingTab(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  renamingTabId = tabId;
  renderTabs();
}

function focusRenameInput() {
  if (!renamingTabId) return;
  requestAnimationFrame(() => {
    const input = elements.tabList.querySelector<HTMLInputElement>(`.tab-rename[data-rename-tab="${CSS.escape(renamingTabId ?? "")}"]`);
    input?.focus();
    input?.select();
  });
}

async function commitTabRename(tabId: string, value: string) {
  if (renamingTabId !== tabId) return;
  const tab = tabs.find((item) => item.id === tabId);
  renamingTabId = undefined;
  if (!tab) {
    renderTabs();
    return;
  }
  const trimmed = value.trim();
  const defaultName = String(tabs.findIndex((item) => item.id === tab.id) + 1);
  if (isHerdrTab(tab)) {
    tab.customTitle = undefined;
    renderTabs();
    updateActiveDetails();
    activePane()?.term?.focus();
    try {
      await runWorkspaceAction("rename_tab", {
        selector: tab.selector,
        tabId,
        label: "",
        apply: false,
      });
      if (trimmed && trimmed !== defaultName) {
        await syncHerdrWorkspaceRenameForTab(tab, trimmed);
      }
    } catch (error) {
      setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
    }
    return;
  }
  tab.customTitle = trimmed && trimmed !== defaultName ? trimmed : undefined;
  renderTabs();
  updateActiveDetails();
  activePane()?.term?.focus();
  try {
    await runWorkspaceAction("rename_tab", {
      selector: tab.selector,
      tabId,
      label: tab.customTitle ?? "",
      apply: false,
    });
    if (tab.customTitle) {
      await syncHerdrWorkspaceRenameForTab(tab, tab.customTitle);
    }
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function syncHerdrWorkspaceRenameForTab(tab: TerminalTab, label: string) {
  const nextLabel = label.trim();
  if (!nextLabel || !isHerdrTab(tab)) return;
  if (!herdrState?.available || normalizeSelector(herdrState.selector) !== normalizeSelector(tab.selector)) {
    await refreshHerdrState(tab.selector);
  }
  const workspace = focusedHerdrWorkspace();
  if (!workspace?.workspace_id) return;
  applyHerdrWorkspaceLabel(workspace.workspace_id, nextLabel);
  renderTabs();
  renderHerdrDock();
  if (workspace.label.trim() === nextLabel) {
    await refreshHerdrState(tab.selector);
    return;
  }
  try {
    await runHerdrSocketRequest("workspace.rename", {
      workspace_id: workspace.workspace_id,
      label: nextLabel,
    }, {
      selector: tab.selector,
      id: `lazycat-webshell:workspace-rename:${tab.id}`,
      mirrorNotification: false,
    });
    await refreshHerdrState(tab.selector);
  } catch (error) {
    setGlobalStatus(tr("status.herdrActionFailed", { message: errorMessage(error) }), "error");
  }
}

function applyHerdrWorkspaceLabel(workspaceId: string, label: string) {
  if (!herdrState?.available) return;
  herdrState = {
    ...herdrState,
    workspaces: herdrState.workspaces.map((workspace) => {
      if (workspace.workspace_id !== workspaceId) return workspace;
      return { ...workspace, label };
    }),
  };
}

function cancelTabRename() {
  renamingTabId = undefined;
  renderTabs();
  activePane()?.term?.focus();
}

function closeActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  void requestCloseTab(tab.id);
}

async function requestCloseTab(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  if (!window.confirm(tr("confirm.closeTab", { name: tabDisplayName(tab) }))) return;
  await closeTab(tabId);
}

async function closeTab(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  try {
    await runWorkspaceAction("close_tab", { selector: tab.selector, tabId });
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function closeActiveSession(tab: TerminalTab, pane: TerminalPane) {
  if (pane.sessionBackend === "herdr") {
    try {
      await closeHerdrPane(pane);
    } catch (error) {
      setGlobalStatus(tr("status.herdrActionFailed", { message: errorMessage(error) }), "error");
    }
    return;
  }
  if (pane.sessionBackend === "zellij") {
    closeZellijPane(pane);
    return;
  }
  if (visiblePanes(tab).length <= 1) {
    await requestCloseTab(tab.id);
    return;
  }
  try {
    await runWorkspaceAction("close_pane", { selector: tab.selector, tabId: tab.id, paneId: pane.id });
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function promoteSessionToNewTab(sourceTab: TerminalTab, pane: TerminalPane) {
  if (visiblePanes(sourceTab).length <= 1) return;
  try {
    await runWorkspaceAction("promote_pane_to_tab", {
      selector: sourceTab.selector,
      tabId: sourceTab.id,
      paneId: pane.id,
    });
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

function disposePaneLocal(pane: TerminalPane) {
  pane.closing = true;
  window.clearTimeout(pane.reconnectTimer);
  clearReplayInputLock(pane);
  pane.socket?.close();
  pane.socket = undefined;
  flushPaneDecoder(pane);
  clearPendingInput(pane);
  pane.term?.dispose();
  pane.term = undefined;
  pane.mount.remove();
}

function updatePaneTitle(pane: TerminalPane, title: string) {
  pane.title = title.trim() || pane.label;
  renderTabs();
  updateActiveDetails();
}

function updateActiveDetails() {
  const tab = activeTab();
  const pane = activePane(tab);
  if (!tab || !pane) {
    elements.emptyState.hidden = false;
    elements.targetLabel.textContent = selectedSelector ? selectorLabel(selectedSelector) : tr("status.instance");
    elements.instanceStatusDot.dataset.status = selectedInstance()?.status ?? "unknown";
    setGlobalStatus(tr("status.idle"));
    document.title = tr("app.title");
    return;
  }

  elements.emptyState.hidden = true;
  elements.targetLabel.textContent = selectorLabel(tab.selector);
  elements.instanceStatusDot.dataset.status = instanceForSelector(tab.selector)?.status ?? "running";
  setGlobalStatus(pane.status, pane.tone);
  document.title = `${tabCurrentTitle(tab)} - ${tr("app.title")}`;
}

function setPaneStatus(pane: TerminalPane, message: string, tone: Tone = "neutral") {
  pane.status = message;
  pane.tone = tone;
  renderTabs();
  if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
    setGlobalStatus(message, tone);
    updateActiveDetails();
  }
}

function setGlobalStatus(message: string, tone: Tone = "neutral") {
  elements.statusLine.textContent = message;
  elements.statusLine.dataset.tone = tone;
}

function sendActivePaneKeyInput(data: string): boolean {
  const pane = activePane();
  if (!pane?.term?.restty || !data) return false;
  pane.term.restty.sendKeyInput(data);
  return true;
}

function isCoarseTouchPointer(event?: PointerEvent): boolean {
  return event?.pointerType === "touch"
    || window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

function shouldFocusTerminalFromPointer(event: PointerEvent): boolean {
  return !isCoarseTouchPointer(event);
}

function focusActivePaneCanvas() {
  focusPaneCanvas(activePane());
}

function focusAfterMobileShortcut() {
  if (isCoarseTouchPointer()) return;
  focusActivePaneCanvas();
}

function focusActivePaneSystemKeyboard() {
  const pane = activePane();
  if (pane) focusPaneSystemKeyboard(pane);
}

function focusPaneCanvas(pane: TerminalPane | undefined) {
  if (!pane) return;
  if (isCoarseTouchPointer()) {
    const canvas = pane.term?.restty?.activePane()?.getRawPane().canvas;
    if (canvas instanceof HTMLElement) {
      canvas.focus({ preventScroll: true });
      return;
    }
  }
  pane.term?.focus();
}

function focusPaneSystemKeyboard(pane: TerminalPane) {
  activatePane(pane.tabId, pane.id, { focus: false });
  const input = paneImeInput(pane);
  if (input) {
    input.focus({ preventScroll: true });
  } else {
    pane.term?.focus();
  }
  handleViewportChange();
}

function isDoubleTerminalTap(pane: TerminalPane, event: PointerEvent): boolean {
  const now = performance.now();
  const dx = event.clientX - lastMobileTerminalTap.x;
  const dy = event.clientY - lastMobileTerminalTap.y;
  const samePane = lastMobileTerminalTap.paneId === pane.id;
  const close = dx * dx + dy * dy <= MOBILE_TERMINAL_DOUBLE_TAP_DISTANCE_PX * MOBILE_TERMINAL_DOUBLE_TAP_DISTANCE_PX;
  const fast = now - lastMobileTerminalTap.time <= MOBILE_TERMINAL_DOUBLE_TAP_DELAY_MS;
  lastMobileTerminalTap.paneId = pane.id;
  lastMobileTerminalTap.time = now;
  lastMobileTerminalTap.x = event.clientX;
  lastMobileTerminalTap.y = event.clientY;
  return samePane && close && fast;
}

function trackMobileTerminalSwipeStart(pane: TerminalPane, event: PointerEvent) {
  if (event.pointerType !== "touch") return;
  mobileTerminalSwipe.paneId = pane.id;
  mobileTerminalSwipe.x = event.clientX;
  mobileTerminalSwipe.y = event.clientY;
  mobileTerminalSwipe.time = performance.now();
}

function readMobileTerminalGesture(pane: TerminalPane, event: PointerEvent): { dx: number; dy: number; elapsed: number } | undefined {
  if (event.pointerType !== "touch" || mobileTerminalSwipe.paneId !== pane.id) return undefined;
  return {
    dx: event.clientX - mobileTerminalSwipe.x,
    dy: event.clientY - mobileTerminalSwipe.y,
    elapsed: performance.now() - mobileTerminalSwipe.time,
  };
}

function clearMobileTerminalGesture() {
  mobileTerminalSwipe.paneId = "";
}

function runMobileTerminalSwipe(gesture: { dx: number; dy: number; elapsed: number }): boolean {
  if (
    gesture.elapsed > MOBILE_TERMINAL_TAB_SWIPE_MAX_MS
    || Math.abs(gesture.dx) < MOBILE_TERMINAL_TAB_SWIPE_DISTANCE_PX
    || Math.abs(gesture.dx) < Math.abs(gesture.dy) * MOBILE_TERMINAL_TAB_SWIPE_RATIO
  ) {
    return false;
  }
  activateAdjacentTab(gesture.dx < 0 ? 1 : -1);
  return true;
}

function isMobileTerminalTapGesture(gesture: { dx: number; dy: number }): boolean {
  return Math.hypot(gesture.dx, gesture.dy) <= MOBILE_TERMINAL_TAP_MOVE_THRESHOLD_PX;
}

function handleTerminalInterruptCapture(event: KeyboardEvent) {
  if (!isCtrlCKeyEvent(event)) return;
  const pane = paneForEventTarget(event.target);
  if (!pane) return;
  const imeActive = event.isComposing || hasPaneImePreedit(pane);
  if (!imeActive && !pane.replaying) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cancelPaneImeComposition(pane, imeActive);
  sendPaneInput(pane, "\x03");
  pane.term?.focus();
}

function handleTerminalClipboardCapture(event: KeyboardEvent) {
  const shortcut = terminalClipboardShortcut(event);
  if (!shortcut) return;
  const pane = paneForShortcutTarget(event.target);
  if (!pane) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (shortcut === "copy") {
    void copySelection(false, pane);
  } else {
    void pasteIntoPane(pane, false);
  }
}

function handleTerminalPasteEvent(event: ClipboardEvent) {
  const pane = paneForShortcutTarget(event.target);
  if (!pane || event.target === paneImeInput(pane)) return;
  event.preventDefault();
  const imageFile = clipboardImageFile(event.clipboardData);
  if (imageFile) {
    void pasteImageFileIntoPane(pane, imageFile, false);
    return;
  }
  const text = event.clipboardData?.getData("text/plain") ?? "";
  if (text) {
    if (pane.sessionBackend === "herdr") {
      void pasteTextIntoHerdrPane(pane, text, false);
    } else {
      pasteTextIntoPane(pane, text);
    }
  } else {
    void pasteIntoPane(pane, false);
  }
}

function terminalClipboardShortcut(event: KeyboardEvent): "copy" | "paste" | undefined {
  if (event.altKey || event.repeat) return undefined;
  const key = event.key.toLowerCase();
  const superShortcut = event.metaKey && !isApplePlatform() && !event.ctrlKey && !event.shiftKey;
  const ctrlShiftShortcut = event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!superShortcut && !ctrlShiftShortcut) return undefined;
  if (key === "c") return "copy";
  if (key === "v") return "paste";
  return undefined;
}

function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

function isCtrlCKeyEvent(event: KeyboardEvent): boolean {
  return event.ctrlKey
    && !event.altKey
    && !event.metaKey
    && !event.shiftKey
    && (event.code === "KeyC" || event.key.toLowerCase() === "c");
}

function paneForEventTarget(target: EventTarget | null): TerminalPane | undefined {
  if (!(target instanceof Node)) return undefined;
  return allPanes().find((pane) => pane.mount.contains(target));
}

function paneForShortcutTarget(target: EventTarget | null): TerminalPane | undefined {
  const targetedPane = paneForEventTarget(target);
  if (targetedPane) return targetedPane;
  if (target instanceof Element && target.closest("input, textarea, select, button, [contenteditable='true']")) {
    return undefined;
  }
  if (!elements.settingsPage.hidden || !activeTabId) return undefined;
  return activePane();
}

function paneImeInput(pane: TerminalPane): HTMLTextAreaElement | null {
  return pane.term?.restty?.activePane()?.getRawPane().imeInput ?? null;
}

function hasPaneImePreedit(pane: TerminalPane): boolean {
  return Boolean(paneImeInput(pane)?.value);
}

function cancelPaneImeComposition(pane: TerminalPane, force: boolean): boolean {
  const input = paneImeInput(pane);
  if (!input || (!force && !input.value)) return false;
  input.value = "";
  try {
    input.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
  } catch {
    input.dispatchEvent(new Event("compositionend"));
  }
  input.value = "";
  return true;
}

function sendPaneInput(pane: TerminalPane, data: string): boolean {
  if (!pane || pane.closing || pane.exited || !pane.sessionId) {
    activePane()?.term?.focus();
    return false;
  }
  if (isInterruptInput(data) && pane.socket?.readyState === WebSocket.OPEN) {
    clearPendingInput(pane);
    clearReplayInputLock(pane);
    pane.socket.send(terminalEncoder.encode(data));
    return true;
  }
  if (pane.socket?.readyState === WebSocket.OPEN && !pane.replaying) {
    pane.socket.send(terminalEncoder.encode(data));
    return true;
  }
  if (!queuePaneInput(pane, data)) {
    activePane()?.term?.focus();
    return false;
  }
  if (pane.socket?.readyState !== WebSocket.CONNECTING && pane.socket?.readyState !== WebSocket.OPEN) {
    connectPanePty(pane);
  }
  return true;
}

function isInterruptInput(data: string): boolean {
  return data === "\x03";
}

function queuePaneInput(pane: TerminalPane, data: string): boolean {
  const bytes = terminalEncoder.encode(data).byteLength;
  if (bytes <= 0 || bytes > MAX_PENDING_INPUT_BYTES) return false;
  while (pane.pendingInputBytes + bytes > MAX_PENDING_INPUT_BYTES) {
    const dropped = pane.pendingInput.shift();
    if (!dropped) break;
    pane.pendingInputBytes = Math.max(0, pane.pendingInputBytes - terminalEncoder.encode(dropped).byteLength);
  }
  pane.pendingInput.push(data);
  pane.pendingInputBytes += bytes;
  return true;
}

function flushPendingInput(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying) return;
  while (pane.pendingInput.length) {
    const data = pane.pendingInput.shift() ?? "";
    pane.pendingInputBytes = Math.max(0, pane.pendingInputBytes - terminalEncoder.encode(data).byteLength);
    try {
      pane.socket.send(terminalEncoder.encode(data));
    } catch {
      pane.pendingInput.unshift(data);
      pane.pendingInputBytes += terminalEncoder.encode(data).byteLength;
      scheduleReconnect(pane);
      return;
    }
  }
}

function clearPendingInput(pane: TerminalPane) {
  pane.pendingInput = [];
  pane.pendingInputBytes = 0;
}

function activeTab(): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === activeTabId);
}

function activePane(tab = activeTab()): TerminalPane | undefined {
  if (!tab) return undefined;
  return tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
}

function allPanes(): TerminalPane[] {
  return tabs.flatMap((tab) => tab.panes);
}

function visiblePanes(tab: TerminalTab): TerminalPane[] {
  return tab.panes.filter((pane) => !pane.closing);
}

function findPaneById(id: string): TerminalPane | undefined {
  return allPanes().find((pane) => pane.id === id);
}

function tabForPane(pane: TerminalPane): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === pane.tabId);
}

function scheduleCopySelection() {
  requestAnimationFrame(() => void copySelection(false));
}

async function copySelection(report: boolean, pane = activePane()): Promise<boolean> {
  const restty = pane?.term?.restty;
  if (settings.useResttyClipboard && restty) {
    try {
      if (await restty.copySelectionToClipboard()) {
        if (report) setGlobalStatus(tr("status.selectionCopied"), "ok");
        return true;
      }
    } catch (error) {
      if (report) setGlobalStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
      return false;
    }
  }

  const text = window.getSelection()?.toString() ?? "";
  if (!text) {
    if (report) setGlobalStatus(tr("status.noSelection"));
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    if (report) setGlobalStatus(tr("status.selectionCopied"), "ok");
    return true;
  } catch (error) {
    if (report) setGlobalStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function pasteIntoPane(pane: TerminalPane | undefined, report: boolean): Promise<boolean> {
  if (!pane?.term?.restty) return false;
  if (pane.sessionBackend === "herdr") {
    return pasteIntoHerdrPane(pane, report);
  }
  const imagePayload = await readClipboardImagePayload();
  if (imagePayload) {
    return sendClipboardImageIntoPane(pane, imagePayload, report);
  }

  if (settings.useResttyClipboard) {
    try {
      if (await pane.term.restty.pasteFromClipboard()) {
        pane.term.focus();
        return true;
      }
    } catch (error) {
      if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
      return false;
    }
  }

  try {
    const text = await navigator.clipboard?.readText?.() ?? "";
    if (!text) return false;
    return pasteTextIntoPane(pane, text);
  } catch (error) {
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

function clipboardImageFile(data: DataTransfer | null | undefined): File | undefined {
  if (!data?.items) return undefined;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return undefined;
}

async function readClipboardImagePayload(): Promise<ClipboardImagePayload | undefined> {
  if (!navigator.clipboard?.read) return undefined;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return imageBlobPayload(blob, type);
    }
  } catch {
  }
  return undefined;
}

async function pasteImageFileIntoPane(pane: TerminalPane, file: File, report: boolean): Promise<boolean> {
  try {
    const payload = await imageBlobPayload(file, file.type);
    if (pane.sessionBackend === "herdr") {
      return pasteClipboardImageIntoHerdrPane(pane, payload, report);
    }
    return sendClipboardImageIntoPane(pane, payload, report);
  } catch (error) {
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function imageBlobPayload(blob: Blob, contentType: string): Promise<ClipboardImagePayload> {
  if (blob.size <= 0) {
    throw new Error("clipboard image is empty");
  }
  if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(`clipboard image exceeds ${Math.floor(MAX_CLIPBOARD_IMAGE_BYTES / (1024 * 1024))} MiB`);
  }
  return {
    extension: imageExtension(contentType),
    data: await blob.arrayBuffer(),
  };
}

function imageExtension(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/gif") return "gif";
  if (type === "image/webp") return "webp";
  if (type === "image/bmp") return "bmp";
  return "png";
}

function sendClipboardImageIntoPane(
  pane: TerminalPane | undefined,
  payload: ClipboardImagePayload,
  report: boolean,
): boolean {
  if (!pane || pane.closing || pane.exited || !pane.sessionId) return false;
  if (payload.data.byteLength <= 0 || payload.data.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return false;
  if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying) {
    connectPanePty(pane);
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: "terminal is reconnecting" }), "error");
    return false;
  }
  try {
    pane.socket.send(JSON.stringify({
      type: "clipboard-image",
      extension: payload.extension,
      size: payload.data.byteLength,
    }));
    pane.socket.send(payload.data);
    pane.term?.focus();
    return true;
  } catch (error) {
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: errorMessage(error) }), "error");
    scheduleReconnect(pane);
    return false;
  }
}

async function stageClipboardImage(selector: string, payload: ClipboardImagePayload): Promise<string> {
  const url = new URL("./api/clipboard-image", window.location.href);
  url.searchParams.set("name", selector);
  url.searchParams.set("extension", payload.extension);
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" },
    body: payload.data,
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const result = await response.json() as { path?: unknown };
  const path = typeof result.path === "string" ? result.path.trim() : "";
  if (!path) throw new Error("clipboard image path is missing");
  return path;
}

function pasteTextIntoPane(pane: TerminalPane | undefined, text: string): boolean {
  if (!pane?.term?.restty || !text) return false;
  pane.term.restty.sendKeyInput(text);
  pane.term.focus();
  return true;
}

function fallbackCopyText(text: string) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function tabTone(tab: TerminalTab): Tone {
  if (tab.panes.some((pane) => pane.tone === "error")) return "error";
  return activePane(tab)?.tone ?? "neutral";
}

function tabCurrentTitle(tab: TerminalTab): string {
  return activePane(tab)?.title || tab.label;
}

function selectedInstance(): Instance | undefined {
  return instances.find((instance) => instanceSelector(instance) === selectedSelector);
}

function instanceForSelector(selector: string): Instance | undefined {
  const normalized = normalizeSelector(selector);
  return instances.find((instance) => instanceSelector(instance) === normalized);
}

function updateIcons() {
  createIcons({ icons });
}
