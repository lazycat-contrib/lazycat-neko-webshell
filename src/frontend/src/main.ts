import "./styles.css";
import "./plugin-tools.css";
import "./webshell-themes.css";
import "./terminal-themes.css";
import "./mobile.css";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createIcons, icons } from "lucide";

import { AIChatStore } from "./ai-chat-store";
import {
  deleteStoredFont,
  deleteTerminalBackgroundFile,
  fetchStoredFonts,
  uploadFontFile,
  uploadTerminalBackgroundFile,
} from "./appearance-api";
import {
  normalizeHexColorInput,
  normalizeInterfaceStyleId,
  terminalBackgroundIdFromUrl,
  validateFontFile,
  validateGhosttyThemeSource,
  validateTerminalBackgroundFile,
} from "./appearance-settings";
import { updateViewportMetrics as applyViewportMetrics } from "./app-viewport";
import { TerminalActionWSClient } from "./action-ws-client";
import { appendAIContextText, recentAIContextText } from "./ai-context";
import {
  emptyAiMcpServer,
  headersFromText,
  headersToText,
  parseAiMcpServers,
  serializeAiMcpServers,
} from "./ai-mcp-settings";
import {
  clipboardImageFile,
  clipboardImagePayloadIsValid,
  imageBlobPayload,
  readClipboardImagePayload,
  stageClipboardImage,
} from "./clipboard-image";
import {
  DEFAULT_SETTINGS,
  INITIAL_COLS,
  INITIAL_ROWS,
  MAX_CUSTOM_THEME_SOURCE_BYTES,
  MAX_OUTPUT_BUFFER_LIMIT,
  MIN_OUTPUT_BUFFER_LIMIT,
  STATUS_REFRESH_MS,
} from "./config";
import { resttyFontSourcesFor, storedFontToResttyPreset } from "./font-registry";
import { FileBrowserStore } from "./file-browser-store";
import { CapabilityService, type Instance, type PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import {
  herdrCurrentPaneId,
  herdrEventChangesDock,
  herdrEventSocketUrl,
  herdrEventSubscriptions,
  herdrEventTone,
  herdrFocusedOrFirstPaneId,
  herdrPaneIdsFromListResult,
  herdrSplitDirection,
} from "./herdr-backend";
import {
  renderHerdrTabButtons,
  renderHerdrWorkspaceButtons,
  renderHerdrWorkspaceMenuView,
} from "./herdr-views";
import { translate, type MessageKey } from "./i18n";
import { renderInstanceListView } from "./instance-views";
import {
  base64ToBytes,
  boolField,
  metaString,
  metaStringArray,
  stringField,
} from "./json-meta";
import { resolveLightOSHomeUrl } from "./lightos-navigation";
import {
  clearMobileSticky as resetMobileSticky,
  createMobileStickyState,
  encodeMobileShortcutInput,
  isMobileModifierShortcut,
  mobileChordInput,
  toggleMobileModifier,
  transformMobileStickyInput as encodeMobileStickyTextInput,
} from "./mobile-shortcuts";
import { renderNewTabMenuView, renderTabsView, type TabViewItem } from "./navigation-views";
import { createTerminalPaneMount, renderPaneSplitNode, updatePaneMountActiveState } from "./pane-dom";
import { createPaneTransport } from "./pane-transport";
import {
  AI_CHAT_PLUGIN_ID,
  downloadPluginPayload,
  FILE_TRANSFER_PLUGIN_ID,
  pluginDescription,
  pluginDisplayName,
  pluginIcon,
  transferProgressText,
} from "./plugin-utils";
import { fileNameFromPath, normalizeRemotePath, parentRemotePath, parseFileBrowserEntries, uploadTargetPath, workingDirectoryFromOsc7, workingDirectoryFromPrompt } from "./remote-files";
import { loadLocalSettings, loadSettings, saveSettings as persistSettings } from "./settings";
import { renderFontFamilyOptions, renderThemeSelectOptions } from "./settings-options-view";
import { activateFontPanel, activateSettingsPanel, bindSettingsTabControls } from "./settings-tabs";
import {
  normalizeSessionMode,
  renderSessionBackendSelectOptions,
  selectableSessionBackends,
  sessionBackendInstalled,
  sessionBackendIsSelectable,
  sessionBackendLabel,
  type SessionMode,
} from "./session-backends";
import { renderShell } from "./shell";
import { paneLayoutNode } from "./split-layout";
import { bindTabWheelSwitch } from "./tab-wheel-switch";
import { installPaneScrollbackFallback } from "./terminal-scrollback";
import {
  normalizeFontHintTarget,
  renderTerminalFontRenderingSettings,
} from "./terminal-fonts";
import {
  installPaneTouchKeyboardGuard,
  installPaneViewportGuard,
  paneImeInput,
  resetPaneViewport,
  schedulePaneViewportReset,
} from "./terminal-viewport";
import { createPaneTerminal } from "./terminal-options";
import { createAIContextPlugin, createTerminalShaderPlugin, TERMINAL_SHADER_PLUGIN_ID } from "./restty-plugins";
import { normalizeTerminalShaderEffect, renderTerminalShaderSettings } from "./terminal-shaders";
import {
  applyCursorAppearance,
  applyTerminalAppearance,
  applyThemeToMount,
  applyThemeVariables,
  currentTerminalFont,
  currentTerminalTheme,
  terminalAppearanceContext,
} from "./terminal-appearance";
import { MAX_PENDING_INPUT_BYTES, monotonicSequence, parseTerminalServerMessage } from "./terminal-protocol";
import { createUploadProgressController } from "./upload-progress";
import { CUSTOM_THEME_PREFIX } from "./theme-registry";
import {
  aiChatTranscript,
  renderAIChatMessages as renderAIChatMessagesView,
  renderAIChatToolView,
  renderFileTransferToolView,
  renderPluginSettingsView,
} from "./plugin-views";
import type {
  AIChatMessage,
  AIChatSession,
  AiMcpServerSettings,
  AiProviderProfile,
  ClipboardImagePayload,
  FileBrowserEntry,
  FontPreset,
  HerdrAction,
  HerdrBridgeState,
  HerdrSocketEnvelope,
  HerdrWorkspaceInfo,
  JsonRecord,
  SessionBackendId,
  SessionBackendInfo,
  SessionBackendsState,
  SplitNode,
  SplitPlacement,
  TerminalPane,
  TerminalTab,
  TerminalTheme,
  Tone,
  WorkspaceAction,
  WorkspacePaneState,
  WorkspaceState,
} from "./types";
import { clampNumber, errorMessage, escapeAttr, escapeHtml, newId, qs, selectorLabel } from "./utils";
import {
  webshellOutputBufferMessage,
  webshellResizeMessage,
  webshellRestartPolicyMessage,
  webshellTerminalSocketUrl,
} from "./webshell-backend";
import {
  fetchHerdrState,
  fetchInstances,
  fetchSessionBackends,
  fetchWorkspace,
  runHerdrActionRequest,
  runHerdrSocketApiRequest,
  runWorkspaceActionRequest,
} from "./workspace-api";
import {
  instanceSelector,
  isRunningInstance,
  lastTabStorageKey,
  normalizeSelector,
  readRememberedSelector,
  readRememberedTabId,
  rememberSelector,
  requestedTabIdFromLocation,
  updateWorkspaceLocation,
} from "./workspace-selection";
import { applyWebshellStyle } from "./webshell-style";
import { zellijPaneModeInput, zellijSplitKey } from "./zellij-backend";

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
const MAX_AI_PROVIDER_PROFILES = 12;
const AI_TERMINAL_CONTEXT_LINES = 40;
type AISettingsTab = "ai" | "mcp";
type AIConfigDialogState = { type: "ai"; profileId?: string; isNew?: boolean } | { type: "mcp"; index: number };
const capabilityClient = createClient(
  CapabilityService,
  createConnectTransport({
    baseUrl: "/",
    fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
  }),
);
const actionClient = new TerminalActionWSClient();

const params = new URLSearchParams(window.location.search);
const initialSelector = normalizeSelector(params.get("name") ?? "");
const initialSelectorExplicit = params.has("name") && Boolean(initialSelector);

const elements = renderShell(qs<HTMLDivElement>("#app"));
const imageUploadProgress = createUploadProgressController(elements.webshell);

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
const aiChat = new AIChatStore();
const fileBrowser = new FileBrowserStore();
let activeAISettingsTab: AISettingsTab = "ai";
let aiConfigDialog: AIConfigDialogState | undefined;
let aiProviderPickerOpen = false;
let tabs: TerminalTab[] = [];
let activeTabId: string | undefined;
let renamingTabId: string | undefined;
let contextPaneId: string | undefined;
let customFonts: FontPreset[] = [];
const mobileSticky = createMobileStickyState();
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
  syncActiveAiProviderProfile();
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
  syncActiveAiProviderProfile();
  void persistSettings(settings);
}

function flushSettings(): Promise<void> {
  syncActiveAiProviderProfile();
  return persistSettings(settings);
}

function tr(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(settings.locale, key, values);
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
      activeTabId,
      replace: options.replaceLocation ?? true,
      tabId: options.tabId,
    });
  }
  return selectedSelectorGeneration;
}

function isCurrentSelectorRequest(selector: string, generation: number): boolean {
  return normalizeSelector(selector) === selectedSelector && generation === selectedSelectorGeneration;
}

function rememberActiveTab() {
  if (!selectedSelector || !activeTabId) return;
  try {
    window.localStorage.setItem(lastTabStorageKey(selectedSelector), activeTabId);
  } catch {
    // localStorage is best-effort; workspace persistence remains server-owned.
  }
  updateWorkspaceLocation(selectedSelector, { activeTabId, replace: true, tabId: activeTabId });
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
  elements.fontFamily.innerHTML = renderFontFamilyOptions(customFonts, tr);
}

function renderThemeOptions() {
  elements.themeSelect.innerHTML = renderThemeSelectOptions(settings.customThemes, tr);
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
    settings.defaultSessionBackend = sessionBackendIsSelectable(sessionBackendsState, backend) ? backend : "webshell";
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
    const target = event.target instanceof Element ? event.target : null;
    const tabButton = target?.closest<HTMLButtonElement>("[data-ai-settings-tab]");
    if (tabButton) {
      activeAISettingsTab = tabButton.dataset.aiSettingsTab === "mcp" ? "mcp" : "ai";
      renderPluginSettings();
      return;
    }
    const openConfigButton = target?.closest<HTMLButtonElement>("[data-ai-config-open]");
    if (openConfigButton) {
      const type = openConfigButton.dataset.aiConfigOpen === "mcp" ? "mcp" : "ai";
      activeAISettingsTab = type === "mcp" ? "mcp" : "ai";
      const isNewAiProfile = openConfigButton.dataset.aiProfileNew === "true" || !activeAiProviderProfile();
      aiConfigDialog = type === "mcp"
        ? { type, index: Number(openConfigButton.dataset.aiMcpIndex ?? "-1") }
        : {
          type,
          profileId: isNewAiProfile ? newId() : openConfigButton.dataset.aiProfileId || activeAiProviderProfile()?.id,
          isNew: isNewAiProfile,
        };
      renderPluginSettings();
      return;
    }
    const saveConfigButton = target?.closest<HTMLButtonElement>("[data-ai-config-save]");
    if (saveConfigButton) {
      saveAIConfigDialog(saveConfigButton.dataset.aiConfigSave ?? "");
      return;
    }
    const removeMcpButton = target?.closest<HTMLButtonElement>("[data-ai-mcp-remove]");
    if (removeMcpButton) {
      removeAiMcpServer(Number(removeMcpButton.dataset.aiMcpRemove));
      return;
    }
    const removeProfileButton = target?.closest<HTMLButtonElement>("[data-ai-profile-remove]");
    if (removeProfileButton) {
      removeAiProviderProfile(removeProfileButton.dataset.aiProfileRemove ?? "");
      return;
    }
    const closeConfigTarget = target?.closest<HTMLElement>("[data-ai-config-close]");
    if (closeConfigTarget && (closeConfigTarget === target || closeConfigTarget instanceof HTMLButtonElement)) {
      aiConfigDialog = undefined;
      renderPluginSettings();
      return;
    }
    const aiButton = target?.closest<HTMLButtonElement>("[data-ai-action]") ?? null;
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
      const path = menuButton.dataset.fileMenuPath ?? fileBrowser.selectedPath;
      fileBrowser.selectPath(path);
      fileBrowser.clearContextMenu();
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
    const providerSelectButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-ai-profile-select]")
      : null;
    if (providerSelectButton) {
      selectAiProviderProfile(providerSelectButton.dataset.aiProfileSelect ?? "");
      return;
    }
    const aiButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-ai-action]")
      : null;
    if (!aiButton) {
      if (aiProviderPickerOpen && !(event.target instanceof Element && event.target.closest(".ai-provider-picker-shell"))) {
        aiProviderPickerOpen = false;
        renderPluginTools();
      }
      return;
    }
    const action = aiButton.dataset.aiAction ?? "";
    if (action === "send-chat") {
      void runAIChat();
    } else if (action === "copy-output") {
      void copyAIOutput();
    } else if (action === "copy-message") {
      void copyAIMessage(Number(aiButton.dataset.aiMessageIndex));
    } else if (action === "copy-code") {
      void copyAICodeBlock(aiButton);
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
    } else if (action === "toggle-provider-menu") {
      aiProviderPickerOpen = !aiProviderPickerOpen;
      renderPluginTools();
    } else if (action === "toggle-terminal-context") {
      toggleAIChatTerminalContext();
    }
  });
  elements.pluginToolBody.addEventListener("contextmenu", (event) => {
    const entryButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-entry]")
      : null;
    if (!entryButton) return;
    event.preventDefault();
    fileBrowser.openContextMenu(entryButton.dataset.fileEntry ?? "", event.clientX, event.clientY);
    renderPluginTools();
  });
  elements.fontFamily.addEventListener("change", () => {
    settings.fontFamilyId = elements.fontFamily.value;
    saveSettings();
    applySettings({ resizeTerminals: true });
  });
  elements.fontRenderingSettings.addEventListener("change", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const ligatures = target?.closest<HTMLInputElement>("#fontLigatures");
    if (ligatures) {
      settings.fontLigatures = ligatures.checked;
      saveSettings();
      applySettings();
      return;
    }
    const hinting = target?.closest<HTMLInputElement>("#fontHinting");
    if (hinting) {
      settings.fontHinting = hinting.checked;
      saveSettings();
      applySettings();
      return;
    }
    const hintTarget = target?.closest<HTMLSelectElement>("#fontHintTarget");
    if (hintTarget) {
      settings.fontHintTarget = normalizeFontHintTarget(hintTarget.value);
      saveSettings();
      applySettings();
    }
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
  elements.terminalShaderSettings.addEventListener("change", (event) => {
    const select = event.target instanceof Element
      ? event.target.closest<HTMLSelectElement>("[data-terminal-shader-effect]")
      : null;
    if (!select) return;
    settings.terminalShaderEffect = normalizeTerminalShaderEffect(select.value);
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
    if (selectableSessionBackends(sessionBackendsState).length <= 1) {
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
  elements.tabList.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const closeButton = target?.closest<HTMLElement>("[data-close-tab]");
    if (closeButton && elements.tabList.contains(closeButton)) {
      event.preventDefault();
      event.stopPropagation();
      void requestCloseTab(closeButton.dataset.closeTab ?? "");
      return;
    }
    if (target instanceof HTMLInputElement) return;
    const tabButton = target?.closest<HTMLElement>(".tab-main[data-tab-id]");
    if (!tabButton || !elements.tabList.contains(tabButton)) return;
    activateTab(tabButton.dataset.tabId ?? "");
  });
  elements.tabList.addEventListener("dblclick", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target instanceof HTMLInputElement) return;
    const tabButton = target?.closest<HTMLElement>(".tab-main[data-tab-id]");
    if (!tabButton || !elements.tabList.contains(tabButton)) return;
    event.preventDefault();
    startRenamingTab(tabButton.dataset.tabId ?? "");
  });
  elements.tabList.addEventListener("keydown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tabButton = target?.closest<HTMLElement>(".tab-main[data-tab-id]");
    if (!tabButton || !elements.tabList.contains(tabButton) || target instanceof HTMLInputElement) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateTab(tabButton.dataset.tabId ?? "");
    } else if (event.key === "F2") {
      event.preventDefault();
      startRenamingTab(tabButton.dataset.tabId ?? "");
    }
  });
  elements.tabList.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return;
    const target = event.target instanceof Element ? event.target : null;
    const tabElement = target?.closest<HTMLElement>(".tab");
    if (!tabElement || !elements.tabList.contains(tabElement)) return;
    const tabId = tabElement.querySelector<HTMLElement>("[data-tab-id]")?.dataset.tabId;
    if (tabId) void requestCloseTab(tabId);
  });
  bindTabWheelSwitch(elements.tabList, {
    tabCount: () => tabs.length,
    canSwitch: () => !renamingTabId,
    switchTab: activateAdjacentTab,
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
    closeAboutDialog();
    if (elements.shortcutHelp.hidden) {
      toggleShortcutHelp();
    }
  });
  elements.openAboutItem.addEventListener("click", (event) => {
    event.stopPropagation();
    closeSettingsMenu();
    openAboutDialog();
  });
  elements.aboutClose.addEventListener("click", () => closeAboutDialog());
  elements.aboutDialog.addEventListener("click", (event) => {
    if (event.target === elements.aboutDialog) {
      closeAboutDialog();
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
      fileBrowser.contextMenu
      && event.target instanceof Element
      && !event.target.closest(".file-browser-context-menu")
    ) {
      fileBrowser.clearContextMenu();
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
      closeAboutDialog();
      closePaneMenu();
      fileBrowser.clearContextMenu();
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
  applyViewportMetrics({
    keyboardInsetThresholdPx: MOBILE_KEYBOARD_INSET_THRESHOLD_PX,
  });
}

function handleViewportChange() {
  updateViewportMetrics();
  scheduleTerminalSizeRefresh();
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
  bindSettingsTabControls(elements, {
    onSettingsTab: activateSettingsTab,
    onFontTab: activateFontTab,
  });
}

function activateSettingsTab(tabId: string) {
  if (!activateSettingsPanel(elements, tabId)) return;
  if (tabId === "plugins" && !pluginsLoaded && !pluginsLoading) {
    void loadPlugins();
  }
}

function activateFontTab(tabId: string) {
  activateFontPanel(elements, tabId);
}

function stopMobileShortcutRepeat() {
  window.clearTimeout(mobileRepeatTimer);
  window.clearInterval(mobileRepeatInterval);
  mobileRepeatTimer = undefined;
  mobileRepeatInterval = undefined;
}

async function runMobileShortcut(shortcut: string, options: { keepModifiers?: boolean } = {}) {
  if (isMobileModifierShortcut(shortcut)) {
    toggleMobileModifier(mobileSticky, shortcut);
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

  const data = encodeMobileShortcutInput(shortcut, mobileSticky);
  if (data) {
    sendActivePaneKeyInput(data);
  }
  if (!options.keepModifiers) {
    clearMobileSticky();
  }
  focusAfterMobileShortcut();
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

function transformMobileStickyInput(text: string, source: string): string | undefined {
  const encoded = encodeMobileStickyTextInput(mobileSticky, text, source);
  if (encoded) updateMobileShortcutState();
  return encoded;
}

function clearMobileSticky() {
  resetMobileSticky(mobileSticky);
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
  closeAboutDialog();
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

function openAboutDialog() {
  closeShortcutHelp();
  closeInstanceMenu();
  closePaneMenu();
  elements.aboutDialog.hidden = false;
  requestAnimationFrame(() => elements.aboutClose.focus());
}

function closeAboutDialog() {
  elements.aboutDialog.hidden = true;
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
  const direction = herdrSplitDirection(placement);
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
  if (!clipboardImagePayloadIsValid(payload)) return false;
  imageUploadProgress.start();
  if (report) setGlobalStatus(tr("status.imageUploadStarted"));
  try {
    const selector = await ensureHerdrSocketReady(pane);
    const paneId = await currentHerdrPaneId(selector);
    void notifyHerdrImageUpload(selector, "status.imageUploadStarted");
    const path = await stageClipboardImage(selector, payload, {
      onProgress: (loaded, total) => {
        if (total > 0) imageUploadProgress.set(0.12 + Math.min(loaded / total, 1) * 0.76);
      },
    });
    if (!path) return false;
    imageUploadProgress.set(0.9);
    await runHerdrSocketRequest("pane.send_text", { pane_id: paneId, text: path }, {
      selector,
      id: "lazycat-webshell:pane-paste-image",
      mirrorNotification: false,
    });
    imageUploadProgress.finish();
    void notifyHerdrImageUpload(selector, "status.imageUploadDone");
    if (report) setGlobalStatus(tr("status.imageUploadDone"), "ok");
    pane.term?.focus();
    return true;
  } catch (error) {
    imageUploadProgress.fail();
    if (report) setGlobalStatus(tr("status.imageUploadFailed", { message: errorMessage(error) }), "error");
    return false;
  }
}

async function notifyHerdrImageUpload(selector: string, key: MessageKey) {
  try {
    await runHerdrSocketRequest("notification.show", { title: tr(key) }, {
      selector,
      id: `lazycat-webshell:image-upload:${key}`,
      mirrorNotification: false,
    });
  } catch {
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
  const currentPaneId = herdrCurrentPaneId(current.result);
  if (currentPaneId) return currentPaneId;

  const workspaceId = herdrState?.workspaces.find((workspace) => workspace.focused)?.workspace_id;
  const list = await runHerdrSocketRequest("pane.list", workspaceId ? { workspace_id: workspaceId } : {}, {
    selector,
    id: "lazycat-webshell:pane-list-current",
    mirrorNotification: false,
  });
  const fallbackPaneId = herdrFocusedOrFirstPaneId(list.result);
  if (fallbackPaneId) return fallbackPaneId;
  throw new Error("Herdr pane not found");
}

function splitZellijPane(pane: TerminalPane, placement: SplitPlacement): boolean {
  const key = zellijSplitKey(placement);
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
  if (sendPaneInput(pane, zellijPaneModeInput(key))) {
    pane.term?.focus();
    return true;
  }
  setBackendActionFailed(pane, "input unavailable");
  return false;
}

function setBackendActionUnavailable(pane: TerminalPane) {
  setGlobalStatus(
    tr("status.backendActionUnavailable", {
      backend: sessionBackendLabel(pane.sessionBackend, pane.sessionBackend, tr),
    }),
    "neutral",
  );
}

function setBackendActionFailed(pane: TerminalPane, message: string) {
  setGlobalStatus(
    tr("status.backendActionFailed", {
      backend: sessionBackendLabel(pane.sessionBackend, pane.sessionBackend, tr),
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
  const appearance = currentAppearanceContext();
  const { theme, font, resttyTheme } = appearance;
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
  elements.fontRenderingSettings.innerHTML = renderTerminalFontRenderingSettings({ settings, tr });
  elements.tabLayout.value = settings.tabLayout;
  applyWebshellStyle(elements.webshell, settings);
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
  elements.terminalShaderSettings.innerHTML = renderTerminalShaderSettings({
    selected: settings.terminalShaderEffect,
    tr,
  });
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
    applyTerminalAppearance(pane, appearance, reportFontLoadError);
    void applyPaneShaderPlugin(pane);
    if (options.resizeTerminals) {
      pane.term?.restty?.setFontSize(settings.fontSize);
      pane.term?.restty?.updateSize(true);
    }
  }
  renderTabs();
  updateActiveDetails();
}

function currentTheme(): TerminalTheme {
  return currentTerminalTheme(settings);
}

function updateSessionBackendSettings() {
  const selectable = selectableSessionBackends(sessionBackendsState);
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
    elements.defaultSessionBackend.innerHTML = renderSessionBackendSelectOptions(selectable, tr);
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
  elements.defaultSessionBackend.innerHTML = renderSessionBackendSelectOptions(selectable, tr);
  elements.defaultSessionBackend.value = selected;
  renderNewTabMenu();
  updateHerdrWorkspaceEntry();
}

function updateHerdrWorkspaceEntry() {
  const hasHerdr = sessionBackendInstalled(sessionBackendsState, "herdr");
  elements.herdrWorkspaceSwitcher.hidden = !hasHerdr;
  if (!hasHerdr) {
    closeHerdrWorkspaceMenu();
  }
}

function currentFont(): FontPreset {
  return currentTerminalFont(settings, terminalFontPresets());
}

function currentAppearanceContext() {
  return terminalAppearanceContext(settings, terminalFontPresets());
}

function terminalFontPresets(): FontPreset[] {
  return customFonts;
}

function reportFontLoadError(error: unknown) {
  setFontStatus(tr("status.fontLoadFailed", { message: errorMessage(error) }), "error");
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
  const parsed = validateGhosttyThemeSource(source, tr);
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

function setThemeStatus(message: string, tone: Tone = "neutral") {
  elements.themeStatus.textContent = message;
  elements.themeStatus.dataset.tone = tone;
}

async function loadUploadedFonts() {
  try {
    const fonts = await fetchStoredFonts();
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
    validateFontFile(file, tr);
    const stored = await uploadFontFile(file);
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
  try {
    await deleteStoredFont(id);
  } catch (error) {
    setFontStatus(tr("status.fontDeleteFailed", { message: errorMessage(error) }), "error");
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
    validateTerminalBackgroundFile(file, tr);
    const background = await uploadTerminalBackgroundFile(file);
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

  try {
    await deleteTerminalBackgroundFile(id);
  } catch (error) {
    setTerminalBackgroundStatus(tr("status.backgroundDeleteFailed", { message: errorMessage(error) }), "error");
    return;
  }
  settings.terminalBackgroundUrl = "";
  settings.terminalBackgroundEnabled = false;
  saveSettings();
  applySettings();
  setTerminalBackgroundStatus(tr("status.backgroundRemoved"));
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
      tr(enabled ? "status.pluginEnabled" : "status.pluginDisabled", { name: pluginDisplayName(updated, tr) }),
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
  elements.refreshPlugins.disabled = pluginsLoading;
  const mcpServers = parseAiMcpServers(settings.aiMcpServers);
  elements.pluginList.innerHTML = renderPluginSettingsView({
    plugins,
    pluginsLoading,
    savingPluginIds: pluginSaveInFlight,
    aiAccess: {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      apiKey: settings.aiApiKey,
      model: settings.aiModel,
      modelOptions: aiChat.modelOptions,
      profiles: settings.aiProviderProfiles,
      activeProfileId: settings.aiActiveProviderProfileId,
      mcpServers,
      activeTab: activeAISettingsTab,
      dialog: aiConfigDialog
        ? aiConfigDialog.type === "mcp"
          ? {
            ...aiConfigDialog,
            server: aiConfigDialog.index >= 0 ? mcpServers[aiConfigDialog.index] ?? emptyAiMcpServer() : emptyAiMcpServer(),
            headersText: headersToText(aiConfigDialog.index >= 0 ? mcpServers[aiConfigDialog.index]?.headers ?? {} : {}),
          }
          : {
            type: "ai",
            profile: aiConfigDialog.isNew
              ? newAiProviderProfile(aiConfigDialog.profileId)
              : aiProviderProfileById(aiConfigDialog.profileId) ?? activeAiProviderProfile() ?? newAiProviderProfile(),
            isNew: Boolean(aiConfigDialog.isNew),
          }
        : undefined,
    },
    tr,
  });
  updateIcons();
}

function pluginControlsDisabled(plugin: PluginDescriptor): boolean {
  return !plugin.enabled || pluginSaveInFlight.has(plugin.id) || pluginsLoading;
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
    <button type="button" role="tab" data-plugin-tool="${escapeAttr(plugin.id)}" aria-selected="${plugin.id === activePluginToolId}" aria-label="${escapeAttr(pluginDisplayName(plugin, tr))}" title="${escapeAttr(pluginDisplayName(plugin, tr))}">
      <i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i>
      <span class="tool-tip">${escapeHtml(pluginDisplayName(plugin, tr))}</span>
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
  if (activePlugin?.id === FILE_TRANSFER_PLUGIN_ID && !fileBrowser.loading && fileBrowser.loadedPath !== normalizeRemotePath(fileBrowser.path)) {
    void loadFileBrowserDirectory(fileBrowser.path);
  }
  if (activePlugin?.id === AI_CHAT_PLUGIN_ID) {
    scrollAIChatToBottom();
  }
}

function renderFileTransferTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  return renderFileTransferToolView({
    disabled,
    fileBrowserPath: fileBrowser.path,
    selectedFileBrowserPath: fileBrowser.selectedPath,
    fileBrowserEntries: fileBrowser.entries,
    fileBrowserLoading: fileBrowser.loading,
    fileBrowserContextMenu: fileBrowser.contextMenu,
    tr,
  });
}

function renderAIChatTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const session = ensureAIChatSession(currentAIChatModelKey());
  return renderAIChatToolView({
    disabled,
    title: tr("plugin.aiChat.name"),
    description: pluginDescription(plugin, tr),
    session,
    messages: session.messages,
    streaming: aiChat.streaming,
    modelOptions: aiModelValues(),
    selectedModel: currentAIModel(),
    sessionOptions: aiChatSessionsForModel(session.model).map((item) => ({ value: item.id, label: item.title })),
    selectedSessionId: aiChat.activeSessionId,
    providerProfiles: settings.aiProviderProfiles,
    activeProviderProfileId: settings.aiActiveProviderProfileId,
    providerPickerOpen: aiProviderPickerOpen,
    sendTerminalContext: session.sendTerminalContext,
    terminalContextPreview: session.sendTerminalContext ? recentAIContext(activePane()) : "",
    tr,
  });
}

async function runFileTransfer(action: string) {
  if (!pluginIsEnabled(FILE_TRANSFER_PLUGIN_ID)) return;
  if (action === "home") {
    await loadFileBrowserDirectory("/");
    return;
  }
  if (action === "sync-cwd") {
    syncFileBrowserPathWithActivePane(true);
    await loadFileBrowserDirectory(fileBrowser.path);
    return;
  }
  if (action === "parent") {
    await loadFileBrowserDirectory(parentRemotePath(fileBrowser.path));
    return;
  }
  if (action === "refresh" || action === "list") {
    await loadFileBrowserDirectory(fileBrowser.path);
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
  const path = fileBrowser.selectedPath || fileBrowser.path;
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

function normalizeAiProviderValue(value: string): string {
  return value === "openai-responses" || value === "anthropic"
    ? value
    : DEFAULT_SETTINGS.aiProvider;
}

function aiProviderProfileById(profileId: string | undefined): AiProviderProfile | undefined {
  if (!profileId) return undefined;
  return settings.aiProviderProfiles.find((profile) => profile.id === profileId);
}

function activeAiProviderProfile(): AiProviderProfile | undefined {
  return aiProviderProfileById(settings.aiActiveProviderProfileId) ?? settings.aiProviderProfiles[0];
}

function newAiProviderProfile(profileId = newId()): AiProviderProfile {
  return {
    id: profileId,
    name: `Provider ${settings.aiProviderProfiles.length + 1}`,
    provider: DEFAULT_SETTINGS.aiProvider,
    baseUrl: "",
    apiKey: "",
    model: "",
  };
}

function syncActiveAiProviderProfile() {
  settings.aiProviderProfiles = settings.aiProviderProfiles
    .slice(0, MAX_AI_PROVIDER_PROFILES)
    .map((profile, index) => sanitizeAiProviderProfile(profile, index));
  const activeProfile = activeAiProviderProfile();
  settings.aiActiveProviderProfileId = activeProfile?.id ?? "";
  settings.aiProvider = activeProfile?.provider ?? DEFAULT_SETTINGS.aiProvider;
  settings.aiBaseUrl = activeProfile?.baseUrl ?? "";
  settings.aiApiKey = activeProfile?.apiKey ?? "";
  settings.aiModel = activeProfile?.model ?? "";
}

function sanitizeAiProviderProfile(profile: AiProviderProfile, index: number): AiProviderProfile {
  return {
    id: profile.id.trim() || (index === 0 ? "default" : `provider-${index + 1}`),
    name: profile.name.trim().slice(0, 48) || `Provider ${index + 1}`,
    provider: normalizeAiProviderValue(profile.provider),
    baseUrl: profile.baseUrl.trim(),
    apiKey: profile.apiKey,
    model: profile.model.trim(),
  };
}

function updateActiveAiProviderProfile(patch: Partial<Omit<AiProviderProfile, "id">>) {
  const activeProfile = activeAiProviderProfile() ?? {
    id: settings.aiActiveProviderProfileId || "default",
    name: "Default",
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    apiKey: settings.aiApiKey,
    model: settings.aiModel,
  };
  const nextProfile = sanitizeAiProviderProfile({ ...activeProfile, ...patch }, 0);
  const profiles = settings.aiProviderProfiles.length ? [...settings.aiProviderProfiles] : [activeProfile];
  const existingIndex = profiles.findIndex((profile) => profile.id === activeProfile.id);
  if (existingIndex >= 0) {
    profiles[existingIndex] = nextProfile;
  } else {
    profiles.unshift(nextProfile);
  }
  settings.aiProviderProfiles = profiles;
  settings.aiActiveProviderProfileId = nextProfile.id;
  syncActiveAiProviderProfile();
}

function upsertAiProviderProfile(profile: AiProviderProfile) {
  const existingIndex = settings.aiProviderProfiles.findIndex((item) => item.id === profile.id);
  const sanitized = sanitizeAiProviderProfile(profile, existingIndex >= 0 ? existingIndex : settings.aiProviderProfiles.length);
  const profiles = [...settings.aiProviderProfiles];
  if (existingIndex >= 0) {
    profiles[existingIndex] = sanitized;
  } else {
    profiles.push(sanitized);
  }
  settings.aiProviderProfiles = profiles.slice(0, MAX_AI_PROVIDER_PROFILES);
  settings.aiActiveProviderProfileId = sanitized.id;
  syncActiveAiProviderProfile();
}

function readAiProviderProfileFromDialog(existing: AiProviderProfile | undefined, isNew: boolean): AiProviderProfile {
  const profileId = existing?.id
    ?? (aiConfigDialog?.type === "ai" ? aiConfigDialog.profileId : undefined)
    ?? newId();
  const fallbackName = existing?.name || (isNew ? `Provider ${settings.aiProviderProfiles.length + 1}` : "Default");
  return {
    id: profileId,
    name: aiDialogStringField("profileName").trim() || fallbackName,
    provider: normalizeAiProviderValue(aiDialogStringField("provider")),
    baseUrl: aiDialogStringField("baseUrl").trim(),
    apiKey: aiDialogStringField("apiKey"),
    model: aiDialogStringField("model").trim(),
  };
}

function aiProviderConnectionChanged(previous: AiProviderProfile, next: AiProviderProfile): boolean {
  return previous.provider !== next.provider
    || previous.baseUrl !== next.baseUrl
    || previous.apiKey !== next.apiKey;
}

function selectAiProviderProfile(profileId: string) {
  if (aiChat.streaming) return;
  if (!aiProviderProfileById(profileId)) return;
  settings.aiActiveProviderProfileId = profileId;
  syncActiveAiProviderProfile();
  aiProviderPickerOpen = false;
  aiChat.modelOptions = [];
  aiChat.activeSessionId = ensureAIChatSession(currentAIChatModelKey()).id;
  saveSettings();
  renderPlugins();
}

function removeAiProviderProfile(profileId: string) {
  if (aiChat.streaming || settings.aiProviderProfiles.length <= 1) return;
  const nextProfiles = settings.aiProviderProfiles.filter((profile) => profile.id !== profileId);
  if (nextProfiles.length === settings.aiProviderProfiles.length) return;
  settings.aiProviderProfiles = nextProfiles;
  if (settings.aiActiveProviderProfileId === profileId) {
    settings.aiActiveProviderProfileId = nextProfiles[0]?.id ?? "";
  }
  syncActiveAiProviderProfile();
  aiConfigDialog = undefined;
  aiProviderPickerOpen = false;
  aiChat.modelOptions = [];
  aiChat.activeSessionId = ensureAIChatSession(currentAIChatModelKey()).id;
  saveSettings();
  setPluginStatus(tr("status.aiConfigSaved"), "ok");
  renderPlugins();
}

function updateAISetting(field: string, value: string) {
  if (field === "provider") {
    updateActiveAiProviderProfile({
      provider: normalizeAiProviderValue(value),
    });
    aiChat.modelOptions = [];
  } else if (field === "baseUrl") {
    updateActiveAiProviderProfile({
      baseUrl: value.trim(),
    });
    aiChat.modelOptions = [];
  } else if (field === "apiKey") {
    updateActiveAiProviderProfile({
      apiKey: value,
    });
    aiChat.modelOptions = [];
  } else if (field === "model") {
    updateActiveAiProviderProfile({
      model: value.trim(),
    });
    aiChat.activeSessionId = ensureAIChatSession(currentAIChatModelKey()).id;
  } else if (field === "session") {
    aiChat.activeSessionId = value;
  }
  saveSettings();
  renderPlugins();
}

function saveAIConfigDialog(type: string) {
  if (!aiConfigDialog || aiConfigDialog.type !== type) return;
  const dialog = aiConfigDialog;
  if (dialog.type === "ai") {
    const existing = !dialog.isNew
      ? aiProviderProfileById(dialog.profileId)
      : undefined;
    const profile = readAiProviderProfileFromDialog(existing, Boolean(dialog.isNew));
    upsertAiProviderProfile(profile);
    if (!existing || aiProviderConnectionChanged(existing, profile)) {
      aiChat.modelOptions = [];
    }
    aiChat.activeSessionId = ensureAIChatSession(currentAIChatModelKey()).id;
    setPluginStatus(tr("status.aiConfigSaved"), "ok");
  } else {
    const url = aiDialogStringField("mcpUrl").trim();
    if (!url) {
      setPluginStatus(tr("validation.mcpUrl"), "error");
      return;
    }
    const transport: AiMcpServerSettings["transport"] = aiDialogStringField("mcpTransport") === "sse" ? "sse" : "streamable-http";
    const server: AiMcpServerSettings = {
      name: aiDialogStringField("mcpName").trim(),
      url,
      transport,
      authorization: aiDialogStringField("mcpAuthorization").trim(),
      headers: headersFromText(aiDialogStringField("mcpHeaders")),
    };
    const servers = parseAiMcpServers(settings.aiMcpServers);
    if (dialog.index >= 0) {
      servers[dialog.index] = server;
    } else {
      servers.push(server);
    }
    settings.aiMcpServers = serializeAiMcpServers(servers);
    activeAISettingsTab = "mcp";
    setPluginStatus(tr("status.mcpServerSaved"), "ok");
  }
  aiConfigDialog = undefined;
  saveSettings();
  renderPlugins();
}

function removeAiMcpServer(index: number) {
  if (!Number.isInteger(index) || index < 0) return;
  const servers = parseAiMcpServers(settings.aiMcpServers);
  if (!servers[index]) return;
  servers.splice(index, 1);
  settings.aiMcpServers = serializeAiMcpServers(servers);
  aiConfigDialog = undefined;
  saveSettings();
  setPluginStatus(tr("status.mcpServerRemoved"), "ok");
  renderPlugins();
}

function aiDialogStringField(field: string): string {
  const input = elements.pluginList.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-ai-dialog-field="${field}"]`);
  return input?.value ?? "";
}

async function fetchAIModels() {
  if (!pluginIsEnabled(AI_CHAT_PLUGIN_ID)) return;
  if (!aiAccessConfigured()) {
    appendAIChatSystem(tr("validation.aiAccess"), "error");
    return;
  }
  try {
    await flushSettings();
    const done = await actionClient.send("ai", "models", {});
    const models = metaStringArray(done.meta, "models");
    aiChat.modelOptions = models;
    if (!settings.aiModel && models[0]) {
      updateActiveAiProviderProfile({ model: models[0] });
      aiChat.activeSessionId = ensureAIChatSession(currentAIChatModelKey()).id;
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
    await flushSettings();
    const done = await actionClient.send("ai", "test", {});
    const models = metaStringArray(done.meta, "models");
    if (models.length) {
      aiChat.modelOptions = models;
      if (!settings.aiModel && models[0]) {
        updateActiveAiProviderProfile({ model: models[0] });
        aiChat.activeSessionId = ensureAIChatSession(currentAIChatModelKey()).id;
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
  if (!pluginIsEnabled(AI_CHAT_PLUGIN_ID) || aiChat.streaming) return;
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
  await flushSettings();
  const session = ensureAIChatSession(currentAIChatModelKey());
  const contextSnapshot = terminalAIContext(session.sendTerminalContext);
  input!.value = "";
  resizeAIChatInput(input!);
  session.messages.push({ role: "user", content: prompt });
  const assistant: AIChatMessage = { role: "assistant", content: "" };
  session.messages.push(assistant);
  aiChat.streaming = true;
  renderPluginTools();
  try {
    await actionClient.send("ai", "chat", {
      input: prompt,
      ctx: contextSnapshot,
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
    aiChat.streaming = false;
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

async function copyAICodeBlock(button: HTMLElement) {
  const code = button.closest(".ai-code-block")?.querySelector<HTMLElement>("code");
  const output = code?.textContent ?? "";
  if (!output.trim()) {
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
  return aiChat.currentModel(settings.aiModel);
}

function currentAIChatModelKey(): string {
  const profileId = settings.aiActiveProviderProfileId || activeAiProviderProfile()?.id || "default";
  const model = currentAIModel() || "default";
  return `${profileId}:${model}`;
}

function activeAIChatSession(): AIChatSession | undefined {
  return aiChat.activeSession();
}

function ensureAIChatSession(model: string): AIChatSession {
  return aiChat.ensureSession(model, tr("plugin.aiChat.block"), newId);
}

function newAIChatSession() {
  const model = currentAIChatModelKey();
  aiChat.newSession(model, tr("plugin.aiChat.block"), newId);
  renderPluginTools();
}

function toggleAIChatTerminalContext() {
  if (aiChat.streaming) return;
  const session = ensureAIChatSession(currentAIChatModelKey());
  session.sendTerminalContext = !session.sendTerminalContext;
  renderPluginTools();
}

function appendAIChatSystem(content: string, tone: Tone = "neutral") {
  aiChat.appendSystem(content, tone, currentAIChatModelKey(), tr("plugin.aiChat.block"), newId);
  renderPluginTools();
}

function aiModelValues(): Array<{ value: string; label: string }> {
  return aiChat.modelValues(settings.aiModel, tr("action.aiFetchModels"));
}

function aiChatSessionsForModel(model: string): AIChatSession[] {
  return aiChat.sessionsForModel(model);
}

function removeAIModelListMessages(models: string[]) {
  aiChat.removeModelListMessages(models);
}

function renderAIChatMessages(): string {
  const session = ensureAIChatSession(currentAIChatModelKey());
  return renderAIChatMessagesView({
    messages: session.messages,
    streaming: aiChat.streaming,
    sendTerminalContext: session.sendTerminalContext,
    terminalContextPreview: session.sendTerminalContext ? recentAIContext(activePane()) : "",
    tr,
  });
}

function renderAIChatMessagesIntoDom() {
  const history = document.querySelector<HTMLElement>("#aiChatHistory");
  if (!history) return;
  history.innerHTML = renderAIChatMessages();
  scrollAIChatToBottom();
}

function scrollAIChatToBottom() {
  const history = document.querySelector<HTMLElement>("#aiChatHistory");
  if (history) history.scrollTop = history.scrollHeight;
}

function resizeAIChatInput(input: HTMLTextAreaElement) {
  input.style.height = "auto";
  input.style.height = `${Math.min(Math.max(input.scrollHeight, 40), 140)}px`;
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

function terminalAIContext(includeTerminalContext: boolean): Record<string, unknown> {
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
  if (includeTerminalContext && pane) {
    context.recent_output = recentAIContext(pane);
    context.context_lines = AI_TERMINAL_CONTEXT_LINES;
  }
  return context;
}

function recentAIContext(pane: TerminalPane | undefined): string {
  if (!pane) return "";
  return recentAIContextText(pane.aiContextText, AI_TERMINAL_CONTEXT_LINES);
}

function appendAIContext(pane: TerminalPane, text: string) {
  if (!text) return;
  pane.aiContextText = appendAIContextText(pane.aiContextText, text);
  updateAIContextLcd(pane);
  if (pane.sessionBackend === "webshell") {
    observeWorkingDirectory(pane, text);
  }
}

function updateAIContextLcd(pane: TerminalPane) {
  if (activePluginToolId !== AI_CHAT_PLUGIN_ID) return;
  if (pane.id !== activePane()?.id) return;
  const session = activeAIChatSession();
  if (!session?.sendTerminalContext) return;
  const preview = document.querySelector<HTMLElement>(".ai-context-lcd pre");
  if (!preview) return;
  preview.textContent = recentAIContext(pane).trim().split(/\r?\n/).slice(-12).join("\n");
  preview.scrollTop = preview.scrollHeight;
}

async function activateFileBrowserEntry(path: string, open = false) {
  const entry = fileBrowser.entries.find((item) => item.path === path);
  if (!entry) return;
  fileBrowser.selectPath(entry.path);
  fileBrowser.clearContextMenu();
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
  const directory = fileBrowser.beginDirectoryLoad(path);
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
    fileBrowser.finishDirectoryLoad(directory, parseFileBrowserEntries(directory, stream));
    setFileTransferOutput("");
  } catch (error) {
    fileBrowser.failDirectoryLoad();
    setFileTransferOutput(errorMessage(error), "error");
  } finally {
    fileBrowser.finishDirectoryLoadWithoutChanges();
    renderPluginTools();
  }
}

function selectedFileBrowserEntry(): FileBrowserEntry | undefined {
  return fileBrowser.selectedEntry();
}

function fileUploadDirectory(): string {
  return fileBrowser.uploadDirectory();
}

function syncFileBrowserPathWithActivePane(force = false) {
  const pane = activePane();
  fileBrowser.syncPathWithPane(pane?.id ?? "", pane?.workingDirectory || "", force);
}

function observeWorkingDirectory(pane: TerminalPane, text: string) {
  const fromOsc = workingDirectoryFromOsc7(text);
  const fromPrompt = fromOsc || workingDirectoryFromPrompt(text);
  if (!fromPrompt) return;
  pane.workingDirectory = fromPrompt;
  if (pane.id === activePane()?.id && activePluginToolId === FILE_TRANSFER_PLUGIN_ID && !fileBrowser.loadedPath) {
    syncFileBrowserPathWithActivePane();
  }
}

function setFileTransferOutput(message: string, tone: Tone = "neutral") {
  const output = document.querySelector<HTMLElement>("#fileTransferOutput");
  if (!output) return;
  output.textContent = message;
  output.dataset.tone = tone;
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
  elements.instanceList.innerHTML = renderInstanceListView(instances, selectedSelector, tr);
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
    const workspace = await fetchWorkspace(requestSelector, {
      cols: INITIAL_COLS,
      rows: INITIAL_ROWS,
      outputLimit: settings.outputBufferLimit,
      autoRestart: settings.autoRestartSessions,
      selectRunningInstanceMessage: tr("status.selectRunningInstance"),
    });
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
  const workspace = await runWorkspaceActionRequest(action, {
    selector,
    cols: INITIAL_COLS,
    rows: INITIAL_ROWS,
    outputLimit: settings.outputBufferLimit,
    autoRestart: settings.autoRestartSessions,
    tabId: options.tabId,
    paneId: options.paneId,
    direction: options.direction,
    label: options.label,
    layout: options.layout,
    activePaneId: options.activePaneId,
    sessionBackend: options.sessionBackend,
  });
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
  if (!sessionBackendInstalled(sessionBackendsState, "herdr") || !herdrState?.available || !herdrState.workspaces.length) return;
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
    const state = await runHerdrActionRequest(selector, action, options);
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
  if (!normalized || !sessionBackendIsSelectable(sessionBackendsState, "herdr")) return false;
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
  const envelope = await runHerdrSocketApiRequest(selector, method, params, { id: options.id });
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
  return herdrPaneIdsFromListResult(envelope.result);
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

  const socket = new WebSocket(herdrEventSocketUrl(selector));
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
  elements.herdrWorkspaceList.innerHTML = renderHerdrWorkspaceButtons(
    herdrState?.workspaces,
    tr("action.closeHerdrSpace"),
  );
  elements.herdrTabList.innerHTML = renderHerdrTabButtons(herdrState?.tabs);
  elements.herdrStatus.textContent = herdrState?.message ?? "";
  renderHerdrWorkspaceMenu();
  void syncHerdrEventBridge();
  updateIcons();
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

function renderNewTabMenu() {
  const selectable = selectableSessionBackends(sessionBackendsState);
  const preferred = preferredBackendForNewTab();
  elements.newTabMenu.innerHTML = renderNewTabMenuView(
    selectable.map((backend) => ({
      id: backend.id,
      label: sessionBackendLabel(backend.id, backend.label, tr),
      selected: backend.id === preferred,
    })),
    tr("status.defaultBackend"),
  );
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
  if (!sessionBackendInstalled(sessionBackendsState, "herdr")) {
    elements.herdrWorkspaceMenuList.replaceChildren();
    elements.herdrWorkspaceMenuStatus.textContent = "";
    return;
  }
  const workspaces = herdrState?.workspaces ?? [];
  elements.herdrWorkspaceMenuList.innerHTML = renderHerdrWorkspaceMenuView(
    workspaces,
    {
      tabs: tr("field.tabs"),
      panes: tr("field.panes"),
      close: tr("action.closeHerdrSpace"),
    },
    herdrState?.message || tr("status.herdrUnavailable"),
  );
  elements.herdrWorkspaceMenuStatus.textContent = herdrState?.message ?? "";
  updateIcons();
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
  pane.terminalShaderEffect = undefined;
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
  const mode = requestedMode && sessionBackendIsSelectable(sessionBackendsState, requestedMode)
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
  if (!sessionBackendIsSelectable(sessionBackendsState, preferred)) return "webshell";
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
  const mount = createTerminalPaneMount(id, `${tab.label} pane`, {
    onPointerDown: (event) => {
      const current = findPaneById(id);
      if (current) {
        trackMobileTerminalSwipeStart(current, event);
        activatePane(current.tabId, id, { focus: false });
        if (shouldFocusTerminalFromPointer(event)) {
          requestAnimationFrame(() => focusPaneCanvas(current));
        }
      }
    },
    onPointerUp: (event) => {
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
    },
    onPointerCancel: (event) => {
      if (event.pointerType === "touch" && mobileTerminalSwipe.paneId === id) {
        clearMobileTerminalGesture();
      }
    },
    onDoubleClick: (event) => {
      event.preventDefault();
      const current = findPaneById(id);
      if (current) {
        focusPaneSystemKeyboard(current);
      }
    },
    onContextMenu: (event) => {
      event.preventDefault();
      const current = findPaneById(id);
      if (!current) return;
      activatePane(current.tabId, id);
      openPaneMenu(event.clientX, event.clientY, id);
    },
    onMouseUp: () => {
      if (settings.copyOnSelect) {
        scheduleCopySelection();
      }
    },
    onTouchEnd: () => {
      if (settings.copyOnSelect) {
        scheduleCopySelection();
      }
    },
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
  pane.transport = createPaneTransport(pane, {
    updateSize: updatePaneTerminalSize,
    openSocket,
    sendInput: sendPaneInput,
    resize: sendPaneResize,
  });
  applyThemeToMount(mount, currentAppearanceContext());
  return pane;
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
    tab.mount.appendChild(renderPaneSplitNode(
      tab.layout,
      new Map(tab.panes.map((pane) => [pane.id, pane.mount])),
    ));
  }
  updatePaneActiveState(tab);
}

function updatePaneActiveState(tab: TerminalTab) {
  updatePaneMountActiveState(tab.panes, tab.activePaneId);
}

async function mountTerminal(pane: TerminalPane) {
  pane.term?.dispose();
  pane.terminalShaderEffect = undefined;
  pane.mount.innerHTML = "";
  applyThemeToMount(pane.mount, currentAppearanceContext());
  pane.decoder = new TextDecoder();

  const term = createPaneTerminal({
    cols: pane.cols || INITIAL_COLS,
    rows: pane.rows || INITIAL_ROWS,
    fontSources: resttyFontSourcesFor(currentFont()),
    fontSize: settings.fontSize,
    fontLigatures: settings.fontLigatures,
    fontHinting: settings.fontHinting,
    fontHintTarget: settings.fontHintTarget,
    scrollbackLimit: settings.scrollbackLimit,
    touchSelectionMode: settings.touchSelectionMode,
    transport: pane.transport,
    beforeInput: ({ text, source }) => transformMobileStickyInput(text, source),
    onGridSize: (cols, rows) => {
      handleTerminalResize(pane, cols, rows);
      applyCursorAppearance(pane, settings);
    },
  });
  if (pane.closing) return;
  pane.term = term;
  term.open(pane.mount);
  term.restty?.setMouseMode("auto");
  void installPaneResttyPlugins(pane);
  installPaneScrollbackFallback(pane, {
    touchSelectionMode: () => settings.touchSelectionMode,
  });
  installPaneTouchKeyboardGuard(pane, {
    scrollLockThresholdPx: MOBILE_TERMINAL_SCROLL_LOCK_THRESHOLD_PX,
    scrollAxisRatio: MOBILE_TERMINAL_SCROLL_AXIS_RATIO,
  });
  installPaneViewportGuard(pane, {
    scheduleSizeRefresh: scheduleTerminalSizeRefresh,
  });
  schedulePaneViewportReset(pane);
  applyTerminalAppearance(pane, currentAppearanceContext(), reportFontLoadError);
  if (activeTabId === pane.tabId && activePane()?.id === pane.id) {
    term.focus();
  }
}

async function installPaneResttyPlugins(pane: TerminalPane) {
  const restty = pane.term?.restty;
  if (!restty || pane.closing) return;
  try {
    await restty.use(createAIContextPlugin({
      onOutput: (text) => appendAIContext(pane, text),
    }));
  } catch (error) {
    if (settings.debugMode) {
      setGlobalStatus(tr("status.pluginLoadFailed", { message: errorMessage(error) }), "error");
    }
  }
  await applyPaneShaderPlugin(pane);
}

async function applyPaneShaderPlugin(pane: TerminalPane) {
  const restty = pane.term?.restty;
  if (!restty || pane.closing) return;
  const effect = normalizeTerminalShaderEffect(settings.terminalShaderEffect);
  if (pane.terminalShaderEffect === effect) return;
  try {
    restty.unuse(TERMINAL_SHADER_PLUGIN_ID);
    pane.terminalShaderEffect = "off";
    if (effect !== "off") {
      await restty.use(createTerminalShaderPlugin({ effect }));
    }
    pane.terminalShaderEffect = effect;
  } catch (error) {
    pane.terminalShaderEffect = undefined;
    if (settings.debugMode) {
      setGlobalStatus(tr("status.pluginLoadFailed", { message: errorMessage(error) }), "error");
    }
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
    pane.socket.send(webshellResizeMessage(pane.cols, pane.rows));
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
  const url = webshellTerminalSocketUrl({
    selector: pane.selector,
    sessionId: pane.sessionId,
    paneId: pane.id,
    sessionBackend: pane.sessionBackend,
    cols: pane.cols || pane.term?.cols || INITIAL_COLS,
    rows: pane.rows || pane.term?.rows || INITIAL_ROWS,
    restart: settings.autoRestartSessions,
    after: pane.lastOutputSequence,
    outputLimit: settings.outputBufferLimit,
  });

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
  applyCursorAppearance(pane, settings);
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
  pane.socket.send(webshellOutputBufferMessage(settings.outputBufferLimit));
}

function sendRestartPolicy(pane: TerminalPane) {
  if (pane.socket?.readyState !== WebSocket.OPEN) return;
  pane.socket.send(webshellRestartPolicyMessage(settings.autoRestartSessions));
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
  refreshAIContextPreviewForActivePane();
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
  refreshAIContextPreviewForActivePane();
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

function refreshAIContextPreviewForActivePane() {
  if (activePluginToolId !== AI_CHAT_PLUGIN_ID) return;
  if (!activeAIChatSession()?.sendTerminalContext) return;
  renderPluginTools();
}

function renderTabs() {
  updateTabChrome();
  elements.tabList.innerHTML = renderTabsView(tabViewItems(), {
    empty: tr("status.noSessions"),
    rename: tr("action.renameTab"),
    close: tr("action.closeTab"),
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
  updateIcons();
  focusRenameInput();
}

function tabViewItems(): TabViewItem[] {
  return tabs.map((tab) => {
    const displayName = tabDisplayName(tab);
    return {
      id: tab.id,
      active: tab.id === activeTabId,
      renaming: renamingTabId === tab.id,
      named: tabHasTextTitle(tab, displayName),
      displayName,
      title: tabCurrentTitle(tab),
      tone: tabTone(tab),
    };
  });
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
  pane.terminalShaderEffect = undefined;
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
  if (!pane) return;
  event.preventDefault();
  event.stopImmediatePropagation();
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
  const code = event.code;
  const superShortcut = event.metaKey && !isApplePlatform() && !event.ctrlKey && !event.shiftKey;
  const ctrlShiftShortcut = event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!superShortcut && !ctrlShiftShortcut) return undefined;
  if (key === "c" || code === "KeyC") return "copy";
  if (key === "v" || code === "KeyV") return "paste";
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

function sendClipboardImageIntoPane(
  pane: TerminalPane | undefined,
  payload: ClipboardImagePayload,
  report: boolean,
): boolean {
  if (!pane || pane.closing || pane.exited || !pane.sessionId) return false;
  if (!clipboardImagePayloadIsValid(payload)) return false;
  if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying) {
    connectPanePty(pane);
    if (report) setGlobalStatus(tr("status.pasteFailed", { message: "terminal is reconnecting" }), "error");
    return false;
  }
  imageUploadProgress.start();
  if (report) setGlobalStatus(tr("status.imageUploadStarted"));
  try {
    pane.socket.send(JSON.stringify({
      type: "clipboard-image",
      extension: payload.extension,
      size: payload.data.byteLength,
    }));
    imageUploadProgress.set(0.35);
    pane.socket.send(payload.data);
    imageUploadProgress.set(0.9);
    imageUploadProgress.finish();
    if (report) setGlobalStatus(tr("status.imageUploadDone"), "ok");
    pane.term?.focus();
    return true;
  } catch (error) {
    imageUploadProgress.fail();
    if (report) setGlobalStatus(tr("status.imageUploadFailed", { message: errorMessage(error) }), "error");
    scheduleReconnect(pane);
    return false;
  }
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
