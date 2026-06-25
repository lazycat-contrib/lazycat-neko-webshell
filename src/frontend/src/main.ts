import "./styles.css";
import "./plugin-tools.css";
import "./webshell-themes.css";
import "./terminal-themes.css";
import "./mobile/styles.css";

import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createIcons, icons } from "lucide";

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
import { appendAIContextText } from "./ai-context";
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
import { clamp, clampFloatingPoint, floatingViewportBounds } from "./floating-position";
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
  selectHerdrTerminalPane,
} from "./herdr-backend";
import {
  renderHerdrTabButtons,
  renderHerdrWorkspaceButtons,
  renderHerdrWorkspaceMenuView,
} from "./herdr-views";
import { translate, type MessageKey } from "./i18n";
import { renderInstanceListView } from "./instance-views";
import {
  boolField,
  metaString,
  stringField,
} from "./json-meta";
import { resolveLightOSHomeUrl } from "./lightos-navigation";
import {
  markMobileQuickPhraseUsed,
} from "./mobile/quick-input";
import { createMobileQuickPhraseSettingsController } from "./mobile/quick-phrase-settings-controller";
import { createMobileKeyboardController } from "./mobile/keyboard-controller";
import { formatMobileClockTime } from "./mobile/clock";
import { createMobileClockController } from "./mobile/clock-controller";
import { blurActiveElement, isMobileOverlayMode, prepareMobileOverlay } from "./mobile/overlay";
import { createMobileSymbolAgentController } from "./mobile/symbol-agent-controller";
import { createMobileTerminalGestureController, isCoarseTouchPointer } from "./mobile/terminal-gestures";
import {
  dismissNotification,
} from "./notifications-api";
import { createNotificationController } from "./notifications/controller";
import { createNotificationDom } from "./notifications/dom";
import { notificationDisplayTitle, notificationTone } from "./notifications/presenter";
import { renderNewTabMenuView, renderTabsView, type TabViewItem } from "./navigation-views";
import { createTerminalPaneMount, renderPaneSplitNode, updatePaneMountActiveState } from "./pane-dom";
import {
  allTabPanes,
  findPaneById as findPaneByIdInTabs,
  findPaneBySessionBackend as findSessionBackendPane,
  selectActivePane,
  selectActiveTab,
  tabForPane as tabForPaneInTabs,
  visibleTabPanes,
} from "./pane-selection";
import { createPaneTransport } from "./pane-transport";
import {
  destroyPaneTransport,
  disposePaneTerminalRuntime,
  replacePaneTransport,
} from "./pane-runtime";
import { createPaneMenuController } from "./pane-menu-controller";
import {
  AI_CHAT_PLUGIN_ID,
  FILE_TRANSFER_PLUGIN_ID,
  LIGHTOS_PORT_FORWARD_PLUGIN_ID,
  POMODORO_PLUGIN_ID,
  pluginDescription,
  pluginDisplayName,
  PUBLIC_TUNNEL_PLUGIN_ID,
  TERMINAL_TRANSFER_PLUGIN_ID,
} from "./plugin-utils";
import { createAIChatController } from "./plugins/ai-chat/controller";
import {
  appendHerdrAIContext,
  recentAIContext as recentAIContextForPane,
} from "./plugins/ai-chat/context";
import { resizeAIChatInput, scrollAIChatToBottom } from "./plugins/ai-chat/dom";
import { renderAIChatToolView } from "./plugins/ai-chat/tool-view";
import { createFileTransferController } from "./plugins/file-transfer/controller";
import { setFileTransferOutput } from "./plugins/file-transfer/dom";
import { renderFileTransferToolView } from "./plugins/file-transfer/tool-view";
import { createPluginJsonInvoker } from "./plugins/invoke-json";
import { createLightOsPortForwardController } from "./plugins/lightos-port-forward/controller";
import { renderLightOsPortForwardToolView } from "./plugins/lightos-port-forward/tool-view";
import { createPomodoroController } from "./plugins/pomodoro/controller";
import { createPomodoroTicker } from "./plugins/pomodoro/ticker";
import { pomodoroToolViewState } from "./plugins/pomodoro/tool-presenter";
import { renderPomodoroToolView } from "./plugins/pomodoro/tool-view";
import { createPublicTunnelController } from "./plugins/public-tunnel/controller";
import {
  parseTunnelProviderProfiles,
  tunnelProfileEditor,
  tunnelProfileSaveInputFromSummary,
  type TunnelProfileDialogState,
  type TunnelProviderProfileSaveInput,
} from "./plugins/public-tunnel/profile-presenter";
import { renderPublicTunnelToolView } from "./plugins/public-tunnel/tool-view";
import { createTerminalTransferController } from "./plugins/terminal-transfer/controller";
import {
  normalizeTerminalTransferProtocols,
  serializeTerminalTransferProtocols,
  TERMINAL_TRANSFER_PROTOCOLS_METADATA,
  terminalTransferProtocolsFromMetadata,
} from "./plugins/terminal-transfer/protocols";
import { renderTerminalTransferToolView } from "./plugins/terminal-transfer/tool-view";
import type {
  TunnelProviderProfileSummary,
} from "./plugins/public-tunnel/types";
import { enabledPluginTools, resolveActivePluginToolId } from "./plugins/tool-registry";
import { renderPluginToolEmpty, renderPluginToolTabs } from "./plugins/tool-shell-view";
import { activeEditableElementIn, isEditableElementTarget } from "./focus-guards";
import { workingDirectoryFromOsc7, workingDirectoryFromPrompt } from "./remote-files";
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
import {
  isHerdrTab,
  defaultTabDisplayName as defaultDisplayNameForTab,
  sortedPinnedTabs as sortPinnedTabs,
  tabCurrentTitle as currentTabTitle,
  tabDisplayName as displayNameForTab,
  tabHasTextTitle as tabHasDisplayTextTitle,
  tabPinnedGlyph as pinnedGlyphForTab,
  tabTone as toneForTab,
} from "./tab-labels";
import { installPaneScrollbackFallback } from "./terminal-scrollback";
import {
  normalizeFontHintTarget,
  renderTerminalFontRenderingSettings,
} from "./terminal-fonts";
import { focusPaneImeInput, preparePaneImeForKeyboardEvent } from "./terminal-ime";
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
import { renderPluginSettingsView } from "./plugin-views";
import type {
  AiMcpServerSettings,
  AiProviderProfile,
  ClipboardImagePayload,
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
  webshellHistoryRecordingMessage,
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
  saveHerdrOutputSequence,
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
const HERDR_REPLAY_TAIL_FRAMES = 80;
const HERDR_OUTPUT_SEQUENCE_FLUSH_DELAY_MS = 500;
const HERDR_FOCUS_REFRESH_DELAYS_MS = [80] as const;
const TERMINAL_SIZE_REFRESH_DELAYS_MS = [80, 250, 600] as const;
const MOBILE_KEYBOARD_INSET_THRESHOLD_PX = 80;
const MOBILE_TERMINAL_SCROLL_LOCK_THRESHOLD_PX = 8;
const MOBILE_TERMINAL_SCROLL_AXIS_RATIO = 1.1;
const MAX_AI_PROVIDER_PROFILES = 12;
const AI_TERMINAL_CONTEXT_LINES = 40;
const POMODORO_REFRESH_MS = 5000;
const NOTIFICATIONS_REFRESH_MS = 5000;
const TUNNEL_PROVIDER_PROFILES_METADATA = "tunnelProviderProfiles";
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
const invokePluginJson = createPluginJsonInvoker(capabilityClient);

const params = new URLSearchParams(window.location.search);
const initialSelector = normalizeSelector(params.get("name") ?? "");
const initialSelectorExplicit = params.has("name") && Boolean(initialSelector);

const elements = renderShell(qs<HTMLDivElement>("#app"));
const imageUploadProgress = createUploadProgressController(elements.webshell);
const mobileKeyboard = createMobileKeyboardController({
  root: elements.mobileShortcuts,
  focusSystemKeyboard: focusActivePaneSystemKeyboard,
  focusAfterShortcut: focusAfterMobileShortcut,
  onKeyInput: sendActivePaneKeyInput,
  onPasteShortcut: async () => {
    await pasteIntoPane(activePane(), false);
  },
  onAction: runMobileAction,
  onPhrase: runMobileQuickPhrase,
});
const mobileQuickPhraseSettings = createMobileQuickPhraseSettingsController({
  elements,
  phrases: () => settings.mobileQuickPhrases,
  setPhrases: (phrases) => {
    settings.mobileQuickPhrases = phrases;
  },
  tr,
  saveSettings,
  updateIcons,
  onChanged: renderMobileQuickInput,
});
const mobileTerminalGestures = createMobileTerminalGestureController({
  activateAdjacentTab,
});
const mobileClock = createMobileClockController({
  elements: {
    clock: elements.mobileShortcutClock,
    enabled: elements.mobileClockEnabled,
    use24Hour: elements.mobileClockUse24Hour,
    showPeriod: elements.mobileClockShowPeriod,
  },
  settings: () => settings,
  tr,
});
const paneMenuController = createPaneMenuController({
  menu: elements.paneMenu,
  prepareOverlay: prepareMobileOverlay,
  isMobileOverlayMode,
  updateIcons,
  findPaneById,
  tabForPane,
  visiblePaneCount: (tab) => visiblePanes(tab).length,
});
const mobileSymbolAgent = createMobileSymbolAgentController({
  activeHerdrPane: () => {
    const pane = activeHerdrTerminalPane();
    if (!pane) return undefined;
    const selector = normalizeSelector(pane.selector || selectedSelector);
    if (!selector) return undefined;
    return { selector, sessionId: pane.sessionId ?? "" };
  },
  ensureHerdrState: async (selector) => {
    const stateMatches = herdrState?.available && normalizeSelector(herdrState.selector) === selector;
    return stateMatches || await refreshHerdrState(selector);
  },
  readCurrentPane: async (selector) => {
    const envelope = await runHerdrSocketRequest("pane.current", {}, {
      selector,
      id: "lazycat-webshell:mobile-symbol-agent",
      mirrorNotification: false,
    });
    return envelope.result;
  },
  onChange: renderMobileQuickInput,
});
const notificationDom = createNotificationDom({
  elements,
  prepareOverlay: prepareMobileOverlay,
  updateIcons,
});
const pomodoro = createPomodoroController({
  isEnabled: () => pluginIsEnabled(POMODORO_PLUGIN_ID),
  refreshNotifications: () => refreshNotifications({ showToast: false }),
  dismissNotification,
  onRender: renderPluginTools,
  onComplete: () => setGlobalStatus(tr("pomodoro.completeTitle"), "ok"),
  onActionError: (error) => setPluginStatus(errorMessage(error), "error"),
  onRefreshError: (error) => {
    if (activePluginToolId === POMODORO_PLUGIN_ID) {
      setPluginStatus(errorMessage(error), "error");
    }
  },
});
const pomodoroTicker = createPomodoroTicker({
  shouldRender: () => activePluginToolId === POMODORO_PLUGIN_ID
    && pluginIsEnabled(POMODORO_PLUGIN_ID)
    && pomodoro.isRunning(),
  onRender: renderPluginTools,
});
const notificationController = createNotificationController({
  render: (items) => notificationDom.render(items, tr, settings.locale),
  renderModal: (notification) => notificationDom.renderModal(notification, tr),
  closeModal: () => notificationDom.closeModal(),
  activeModalId: () => notificationDom.activeNotificationModalId(),
  refreshPomodoro: () => pomodoro.refresh(true),
  onToast: (notification) => setGlobalStatus(notificationDisplayTitle(notification, tr), notificationTone(notification)),
  onPomodoroNotification: () => {
    void pomodoro.refresh(true);
  },
  onLoadError: (error) => setGlobalStatus(tr("status.notificationLoadFailed", { message: errorMessage(error) }), "error"),
  onActionError: (error) => setGlobalStatus(tr("status.notificationActionFailed", { message: errorMessage(error) }), "error"),
});

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
const pendingHerdrOutputSequences = new Map<string, { selector: string; sequence: number }>();
const herdrOutputSequenceTimers = new Map<string, number>();
let plugins: PluginDescriptor[] = [];
let pluginsLoaded = false;
let pluginsLoading = false;
let activePluginToolId = "";
const aiChat = createAIChatController({
  isEnabled: () => pluginIsEnabled(AI_CHAT_PLUGIN_ID),
  accessConfigured: aiAccessConfigured,
  configuredModel: () => settings.aiModel,
  activeProfileId: () => settings.aiActiveProviderProfileId || activeAiProviderProfile()?.id || "default",
  setConfiguredModel: (model) => updateActiveAiProviderProfile({ model }),
  saveSettings,
  flushSettings,
  terminalContext: terminalAIContext,
  recentTerminalContext: () => recentAIContext(activePane()),
  inputElement: () => document.querySelector<HTMLTextAreaElement>("#aiChatInput"),
  actionClient,
  tr,
  createId: newId,
  onStatus: setPluginStatus,
  onRender: renderPluginTools,
});
const fileTransfer = createFileTransferController({
  isEnabled: () => pluginIsEnabled(FILE_TRANSFER_PLUGIN_ID),
  activePane,
  actionClient,
  tr,
  onOutput: setFileTransferOutput,
  onStatus: setPluginStatus,
  onRender: renderPluginTools,
});
const publicTunnel = createPublicTunnelController({
  isEnabled: () => pluginIsEnabled(PUBLIC_TUNNEL_PLUGIN_ID),
  sessionId: () => activePane()?.sessionId,
  profiles: publicTunnelProfiles,
  invokeJson: invokePluginJson,
  tr,
  onStatus: setPluginStatus,
  onRender: renderPluginTools,
});
const lightosPortForward = createLightOsPortForwardController({
  isEnabled: () => pluginIsEnabled(LIGHTOS_PORT_FORWARD_PLUGIN_ID),
  sessionId: () => activePane()?.sessionId,
  invokeJson: invokePluginJson,
  tr,
  onStatus: setPluginStatus,
  onRender: renderPluginTools,
  onLocalUrl: (localUrl) => publicTunnel.setUpstreamIfEmpty(localUrl),
});
const terminalTransfer = createTerminalTransferController({
  isEnabled: () => pluginIsEnabled(TERMINAL_TRANSFER_PLUGIN_ID),
  enabledProtocols: currentTerminalTransferProtocols,
  sendBytes: sendPaneBytes,
  writeTerminalBytes,
  writeTerminalText,
  setHistoryRecording: sendHistoryRecording,
  tr,
  onStatus: setGlobalStatus,
  onRender: renderPluginTools,
});
let activeAISettingsTab: AISettingsTab = "ai";
let aiConfigDialog: AIConfigDialogState | undefined;
let tunnelProfileDialog: TunnelProfileDialogState | undefined;
let aiProviderPickerOpen = false;
let tabs: TerminalTab[] = [];
let activeTabId: string | undefined;
let renamingTabId: string | undefined;
let customFonts: FontPreset[] = [];
let pomodoroPollingTimer: number | undefined;
let notificationsPollingTimer: number | undefined;
const pluginSaveInFlight = new Set<string>();
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
  pomodoroTicker.start();
  startPomodoroPolling();
  startNotificationsPolling();
  await pomodoro.refresh(false);
  await refreshNotifications({ showToast: true });
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
    const terminalTransferProtocol = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-terminal-transfer-protocol]")
      : null;
    if (terminalTransferProtocol) {
      void configureTerminalTransferProtocols(
        terminalTransferProtocol.dataset.terminalTransferProtocol ?? "",
        terminalTransferProtocol.checked,
      );
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
    const tokenToggleButton = target?.closest<HTMLButtonElement>("[data-tunnel-token-toggle]");
    if (tokenToggleButton) {
      event.preventDefault();
      event.stopPropagation();
      toggleTunnelTokenVisibility(tokenToggleButton);
      return;
    }
    const openTunnelProfileButton = target?.closest<HTMLButtonElement>("[data-tunnel-profile-open]");
    if (openTunnelProfileButton) {
      const profileId = openTunnelProfileButton.dataset.tunnelProfileOpen ?? "";
      tunnelProfileDialog = profileId === "new"
        ? { profileId: newId(), isNew: true }
        : { profileId, isNew: false };
      renderPluginSettings();
      return;
    }
    const saveTunnelProfileButton = target?.closest<HTMLButtonElement>("[data-tunnel-profile-save]");
    if (saveTunnelProfileButton) {
      void saveTunnelProfileDialog();
      return;
    }
    const removeTunnelProfileButton = target?.closest<HTMLButtonElement>("[data-tunnel-profile-remove]");
    if (removeTunnelProfileButton) {
      void removeTunnelProfile(removeTunnelProfileButton.dataset.tunnelProfileRemove ?? "");
      return;
    }
    const closeTunnelProfileTarget = target?.closest<HTMLElement>("[data-tunnel-profile-close]");
    if (closeTunnelProfileTarget && (closeTunnelProfileTarget === target || closeTunnelProfileTarget instanceof HTMLButtonElement)) {
      tunnelProfileDialog = undefined;
      renderPluginSettings();
      return;
    }
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
      void aiChat.fetchModels();
    } else if (action === "test") {
      void aiChat.testAccess();
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
      return;
    }
    const portField = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-port-forward-field]")
      : null;
    if (portField) {
      lightosPortForward.updateField(portField.dataset.portForwardField ?? "", portField.value);
      return;
    }
    const tunnelField = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-public-tunnel-field]")
      : null;
    if (tunnelField) {
      publicTunnel.updateField(tunnelField.dataset.publicTunnelField ?? "", tunnelField.value);
    }
  });
  elements.pluginToolBody.addEventListener("change", (event) => {
    const upload = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-file-upload]")
      : null;
    if (upload) {
      const files = Array.from(upload.files ?? []);
      if (files.length) {
        void fileTransfer.upload(files).finally(() => {
          upload.value = "";
        });
      }
      return;
    }
    const pomodoroMinutes = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-pomodoro-minutes]")
      : null;
    if (pomodoroMinutes) {
      pomodoro.setDraftMinutes(pomodoroMinutes.value);
      renderPluginTools();
      return;
    }
    const pomodoroRounds = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("[data-pomodoro-rounds]")
      : null;
    if (pomodoroRounds) {
      pomodoro.setDraftRounds(pomodoroRounds.value);
      renderPluginTools();
      return;
    }
    const aiSetting = event.target instanceof Element
      ? event.target.closest<HTMLSelectElement>("[data-ai-chat-setting]")
      : null;
    if (aiSetting) {
      updateAISetting(aiSetting.dataset.aiChatSetting ?? "", aiSetting.value);
      return;
    }
    const tunnelField = event.target instanceof Element
      ? event.target.closest<HTMLSelectElement>("[data-public-tunnel-field]")
      : null;
    if (tunnelField) {
      publicTunnel.updateField(tunnelField.dataset.publicTunnelField ?? "", tunnelField.value);
    }
  });
  elements.pluginToolBody.addEventListener("keydown", (event) => {
    const input = event.target instanceof Element
      ? event.target.closest<HTMLTextAreaElement>("#aiChatInput")
      : null;
    if (!input || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    event.preventDefault();
    void aiChat.run();
  });
  elements.pluginToolBody.addEventListener("click", (event) => {
    const entryButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-entry]")
      : null;
    if (entryButton) {
      void fileTransfer.activateEntry(entryButton.dataset.fileEntry ?? "", event.detail > 1);
      return;
    }
    const menuButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-menu-action]")
      : null;
    if (menuButton) {
      fileTransfer.selectMenuPath(menuButton.dataset.fileMenuPath ?? "");
      void fileTransfer.runAction(menuButton.dataset.fileMenuAction ?? "");
      return;
    }
    const fileButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-transfer-action]")
      : null;
    if (fileButton) {
      void fileTransfer.runAction(fileButton.dataset.fileTransferAction ?? "");
      return;
    }
    const copyButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-network-copy]")
      : null;
    if (copyButton) {
      void copyNetworkUrl(copyButton.dataset.networkCopy ?? "");
      return;
    }
    const portActionButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-port-forward-action]")
      : null;
    if (portActionButton) {
      void lightosPortForward.runAction(portActionButton.dataset.portForwardAction ?? "");
      return;
    }
    const releaseForwardButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-port-forward-release]")
      : null;
    if (releaseForwardButton) {
      void lightosPortForward.release(releaseForwardButton.dataset.portForwardRelease ?? "");
      return;
    }
    const useForwardButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-port-forward-use-tunnel]")
      : null;
    if (useForwardButton) {
      useForwardForTunnel(useForwardButton.dataset.portForwardUseTunnel ?? "");
      return;
    }
    const tunnelUpstreamButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-public-tunnel-upstream]")
      : null;
    if (tunnelUpstreamButton) {
      publicTunnel.useUpstreamUrl(tunnelUpstreamButton.dataset.publicTunnelUpstream ?? "");
      return;
    }
    const tunnelActionButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-public-tunnel-action]")
      : null;
    if (tunnelActionButton) {
      void publicTunnel.runAction(tunnelActionButton.dataset.publicTunnelAction ?? "");
      return;
    }
    const stopTunnelButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-public-tunnel-stop]")
      : null;
    if (stopTunnelButton) {
      void publicTunnel.stop(stopTunnelButton.dataset.publicTunnelStop ?? "");
      return;
    }
    const pomodoroPresetButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-pomodoro-preset]")
      : null;
    if (pomodoroPresetButton) {
      pomodoro.setDraftMinutes(pomodoroPresetButton.dataset.pomodoroPreset);
      renderPluginTools();
      return;
    }
    const pomodoroActionButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-pomodoro-action]")
      : null;
    if (pomodoroActionButton) {
      void pomodoro.runAction(pomodoroActionButton.dataset.pomodoroAction ?? "");
      return;
    }
    const terminalTransferActionButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-transfer-action]")
      : null;
    if (terminalTransferActionButton) {
      if (terminalTransferActionButton.dataset.terminalTransferAction === "cancel") {
        terminalTransfer.cancel();
      }
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
      void aiChat.run();
    } else if (action === "copy-output") {
      aiChat.copyOutput();
    } else if (action === "copy-message") {
      aiChat.copyMessage(Number(aiButton.dataset.aiMessageIndex));
    } else if (action === "copy-code") {
      aiChat.copyCodeBlock(aiButton);
    } else if (action === "clear-output") {
      aiChat.clearOutput();
    } else if (action === "new-chat") {
      aiChat.newSession();
    } else if (action === "export-chat") {
      aiChat.export();
    } else if (action === "models") {
      void aiChat.fetchModels();
    } else if (action === "test") {
      void aiChat.testAccess();
    } else if (action === "toggle-provider-menu") {
      aiProviderPickerOpen = !aiProviderPickerOpen;
      renderPluginTools();
    } else if (action === "toggle-terminal-context") {
      aiChat.toggleTerminalContext();
    }
  });
  elements.pluginToolBody.addEventListener("contextmenu", (event) => {
    const entryButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-entry]")
      : null;
    if (!entryButton) return;
    event.preventDefault();
    const point = clampFloatingPoint(event.clientX, event.clientY, {
      width: 180,
      height: 260,
      margin: isMobileOverlayMode() ? 10 : 8,
    });
    fileTransfer.openContextMenu(entryButton.dataset.fileEntry ?? "", point.x, point.y);
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
  elements.mobileClockEnabled.addEventListener("change", () => {
    settings.mobileClockEnabled = elements.mobileClockEnabled.checked;
    mobileClock.updateSettingsState();
    saveSettings();
    mobileClock.update();
  });
  elements.mobileClockUse24Hour.addEventListener("change", () => {
    settings.mobileClockUse24Hour = elements.mobileClockUse24Hour.checked;
    mobileClock.updateSettingsState();
    saveSettings();
    mobileClock.update();
  });
  elements.mobileClockShowPeriod.addEventListener("change", () => {
    settings.mobileClockShowPeriod = elements.mobileClockShowPeriod.checked;
    saveSettings();
    mobileClock.update();
  });
  elements.mobileQuickPhraseList.addEventListener("click", (event) => {
    const removeButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-quick-phrase-remove]")
      : null;
    if (removeButton) {
      mobileQuickPhraseSettings.remove(removeButton.dataset.quickPhraseRemove ?? "");
      return;
    }
    const editButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-quick-phrase-edit]")
      : null;
    if (editButton) {
      mobileQuickPhraseSettings.beginEdit(editButton.dataset.quickPhraseEdit ?? "");
    }
  });
  elements.mobileQuickPhraseSave.addEventListener("click", () => mobileQuickPhraseSettings.save());
  elements.mobileQuickPhraseCancel.addEventListener("click", () => mobileQuickPhraseSettings.reset());
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
    const pinButton = target?.closest<HTMLElement>("[data-pin-tab]");
    if (pinButton && elements.tabList.contains(pinButton)) {
      event.preventDefault();
      event.stopPropagation();
      void toggleTabPinned(pinButton.dataset.pinTab ?? "");
      return;
    }
    const moveButton = target?.closest<HTMLElement>("[data-move-pinned-tab]");
    if (moveButton && elements.tabList.contains(moveButton)) {
      event.preventDefault();
      event.stopPropagation();
      const direction = moveButton.dataset.direction === "-1" ? -1 : 1;
      void movePinnedTab(moveButton.dataset.movePinnedTab ?? "", direction);
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
  elements.notificationsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleNotificationsMenu();
  });
  elements.notificationList.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionButton = target?.closest<HTMLButtonElement>("[data-notification-action]");
    if (actionButton) {
      void runNotificationActionFromButton(actionButton);
      return;
    }
    const commandButton = target?.closest<HTMLButtonElement>("[data-notification-command]");
    if (commandButton) {
      void runNotificationCommand(commandButton.dataset.notificationCommand ?? "", commandButton.dataset.notificationId ?? "");
      return;
    }
    const link = target?.closest<HTMLAnchorElement>("[data-notification-link]");
    if (link) {
      const id = link.dataset.notificationId ?? "";
      if (id) void notificationController.markRead(id).catch(() => {});
    }
  });
  elements.notificationModal.addEventListener("click", (event) => {
    if (event.target === elements.notificationModal) {
      closeNotificationModal();
    }
  });
  elements.notificationModalBody.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionButton = target?.closest<HTMLButtonElement>("[data-notification-action]");
    if (actionButton) {
      void runNotificationActionFromButton(actionButton);
      return;
    }
    const commandButton = target?.closest<HTMLButtonElement>("[data-notification-command]");
    if (commandButton) {
      void runNotificationCommand(commandButton.dataset.notificationCommand ?? "", commandButton.dataset.notificationId ?? "");
      return;
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
  document.addEventListener("keydown", handleTerminalImeFocusCapture, true);
  document.addEventListener("keydown", handleTerminalInterruptCapture, true);
  document.addEventListener("keydown", handleTerminalClipboardCapture, true);
  document.addEventListener("paste", handleTerminalPasteEvent, true);
  elements.instanceButton.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleInstanceMenu();
  });
  elements.terminalStage.addEventListener("pointerdown", (event) => {
    if (!shouldFocusTerminalFromPointer(event)) return;
    focusActivePaneCanvas({ force: true });
    requestAnimationFrame(() => focusActivePaneCanvas({ force: true }));
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
    if (event.target instanceof Node && !elements.notificationsMenu.contains(event.target) && event.target !== elements.notificationsButton) {
      closeNotificationsMenu();
    }
    if (event.target instanceof Node && !elements.shortcutHelp.contains(event.target) && event.target !== elements.shortcutHelpButton) {
      closeShortcutHelp();
    }
    if (event.target instanceof Node && !elements.paneMenu.contains(event.target)) {
      paneMenuController.close();
    }
    if (
      fileTransfer.hasContextMenu()
      && event.target instanceof Element
      && !event.target.closest(".file-browser-context-menu")
    ) {
      if (fileTransfer.clearContextMenu()) renderPluginTools();
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
      closeNotificationsMenu();
      closeNotificationModal();
      closeShortcutHelp();
      closeAboutDialog();
      paneMenuController.close();
      fileTransfer.clearContextMenu();
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
  window.addEventListener("pagehide", flushHerdrOutputSequences);
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
  mobileKeyboard.bind();
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

async function runMobileQuickPhrase(id: string) {
  const phrase = settings.mobileQuickPhrases.find((item) => item.id === id);
  if (!phrase?.text) return;
  const pane = activeHerdrTerminalPane() ?? activePane();
  if (!pane) return;
  const sent = pane.sessionBackend === "herdr"
    ? await pasteTextIntoHerdrPane(pane, phrase.text, true)
    : pasteTextIntoPane(pane, phrase.text);
  if (!sent) return;
  settings.mobileQuickPhrases = markMobileQuickPhraseUsed(settings.mobileQuickPhrases, id);
  saveSettings();
  renderMobileQuickInput();
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
  mobileKeyboard.clearSticky();
  if (action !== "pane-menu") {
    focusAfterMobileShortcut();
  }
}

function transformMobileStickyInput(text: string, source: string): string | undefined {
  return mobileKeyboard.encodeStickyInput(text, source);
}

function renderMobileQuickInput() {
  const phrases = mobileKeyboard.renderQuickInput({
    phrases: settings.mobileQuickPhrases,
    symbolAgent: mobileSymbolAgent.current(),
    tr,
  });
  if (phrases !== settings.mobileQuickPhrases) {
    settings.mobileQuickPhrases = phrases;
  }
  renderMobileQuickPhraseSettings();
  mobileClock.update();
}

function renderMobileQuickPhraseSettings() {
  mobileQuickPhraseSettings.render();
}

function startPomodoroPolling() {
  window.clearInterval(pomodoroPollingTimer);
  pomodoroPollingTimer = window.setInterval(() => {
    void pomodoro.refresh(true);
  }, POMODORO_REFRESH_MS);
}

function startNotificationsPolling() {
  window.clearInterval(notificationsPollingTimer);
  notificationsPollingTimer = window.setInterval(() => {
    void refreshNotifications({ showToast: true });
  }, NOTIFICATIONS_REFRESH_MS);
}

function toggleNotificationsMenu() {
  const open = elements.notificationsMenu.hidden;
  if (open) {
    prepareMobileOverlay();
  }
  closeSettingsMenu();
  closeInstanceMenu();
  closeNewTabMenu();
  closeHerdrWorkspaceMenu();
  elements.notificationsMenu.hidden = !open;
  elements.notificationsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    void refreshNotifications({ showToast: false });
  }
}

function closeNotificationsMenu() {
  notificationDom.closeMenu();
}

function renderNotifications() {
  notificationController.renderCurrent();
}

function closeNotificationModal() {
  notificationDom.closeModal();
}

async function runNotificationCommand(command: string, id: string) {
  await notificationController.runCommand(command, id);
}

async function runNotificationActionFromButton(button: HTMLButtonElement) {
  const id = button.dataset.notificationId ?? "";
  const actionId = button.dataset.notificationAction ?? "";
  await notificationController.runAction(id, actionId);
}

async function refreshNotifications(options: { showToast?: boolean } = {}) {
  await notificationController.refresh(options);
}

async function navigateLightOSHome() {
  closeInstanceMenu();
  paneMenuController.close();
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
  prepareMobileOverlay();
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

function closeSettings(options: { restoreFocus?: boolean } = {}) {
  elements.settingsPage.hidden = true;
  elements.webshell.classList.remove("settings-open");
  setAppBackgroundInert(false);
  if (options.restoreFocus !== false) {
    restoreTerminalFocusAfterOverlay();
  }
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
  if (open) {
    prepareMobileOverlay();
  }
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
  prepareMobileOverlay();
  closeSettingsMenu();
  closeShortcutHelp();
  closeInstanceMenu();
  paneMenuController.close();
  if (!elements.settingsPage.hidden) {
    closeSettings({ restoreFocus: false });
  }
  elements.pluginSidebar.hidden = false;
  elements.webshell.classList.add("plugins-open");
  elements.pluginsButton.setAttribute("aria-expanded", "true");
  if (!pluginsLoaded && !pluginsLoading) {
    void loadPlugins();
  } else {
    renderPluginTools();
  }
}

function closePluginSidebar(options: { restoreFocus?: boolean } = {}) {
  elements.pluginSidebar.hidden = true;
  elements.webshell.classList.remove("plugins-open");
  elements.pluginsButton.setAttribute("aria-expanded", "false");
  if (options.restoreFocus !== false) {
    restoreTerminalFocusAfterOverlay();
  }
}

function toggleShortcutHelp() {
  const open = elements.shortcutHelp.hidden;
  if (open) {
    prepareMobileOverlay();
  }
  closeSettingsMenu();
  closeInstanceMenu();
  paneMenuController.close();
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
  prepareMobileOverlay();
  closeShortcutHelp();
  closeInstanceMenu();
  paneMenuController.close();
  elements.aboutDialog.hidden = false;
  requestAnimationFrame(() => elements.aboutClose.focus());
}

function closeAboutDialog() {
  elements.aboutDialog.hidden = true;
}

async function toggleFullscreen() {
  const mobileMode = isMobileOverlayMode();
  if (mobileMode) {
    closeMobileOverlaysBeforeViewportChange();
  }
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await elements.webshell.requestFullscreen();
    }
  } catch {
    if (!mobileMode) {
      focusActivePaneCanvas();
    }
  } finally {
    handleViewportChange();
  }
}

function closeMobileOverlaysBeforeViewportChange() {
  blurActiveElement();
  closeSettingsMenu();
  closeInstanceMenu();
  closeNewTabMenu();
  closeHerdrWorkspaceMenu();
  closeNotificationsMenu();
  paneMenuController.close();
  closeShortcutHelp();
  closeAboutDialog();
  closeNotificationModal();
  if (!elements.settingsPage.hidden) {
    closeSettings({ restoreFocus: false });
  }
  if (!elements.pluginSidebar.hidden) {
    closePluginSidebar({ restoreFocus: false });
  }
}

function restoreTerminalFocusAfterOverlay() {
  if (!isMobileOverlayMode()) {
    focusActivePaneCanvas();
  }
}

function toggleInstanceMenu() {
  const open = elements.instanceMenu.hidden;
  if (open) {
    prepareMobileOverlay();
  }
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

function openActivePaneMenu() {
  const pane = activePane();
  if (!pane) return;
  paneMenuController.openForPane(pane);
}

async function runPaneMenuAction(action: string) {
  const pane = paneMenuController.targetPane(activePane());
  const tab = pane ? tabForPane(pane) : undefined;
  paneMenuController.close();
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
  refreshHerdrPaneTerminalAfterAction(pane);
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
  refreshHerdrPaneTerminalAfterAction(pane);
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
    focusPaneCanvas(pane);
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
    focusPaneCanvas(pane);
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
    focusPaneCanvas(pane);
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
  return isEditableElementTarget(target);
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
  mobileClock.updateSettingsState();
  elements.autoRestartSessions.checked = settings.autoRestartSessions;
  elements.debugMode.checked = settings.debugMode;
  updateSessionBackendSettings();
  renderMobileQuickInput();
  renderPlugins();
  renderNotifications();

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
  mobileClock.start();
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
    syncPublicTunnelProviderSelection();
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

function publicTunnelPlugin(): PluginDescriptor | undefined {
  return plugins.find((plugin) => plugin.id === PUBLIC_TUNNEL_PLUGIN_ID);
}

function publicTunnelProfiles(): TunnelProviderProfileSummary[] {
  return parseTunnelProviderProfiles(publicTunnelPlugin()?.metadata[TUNNEL_PROVIDER_PROFILES_METADATA]);
}

function syncPublicTunnelProviderSelection() {
  publicTunnel.syncProviderSelection();
}

async function saveTunnelProfileDialog() {
  if (!tunnelProfileDialog) return;
  const name = tunnelProfileField<HTMLInputElement>("name")?.value.trim() ?? "";
  const authtoken = tunnelProfileField<HTMLInputElement>("authtoken")?.value.trim() ?? "";
  const enabled = tunnelProfileField<HTMLInputElement>("enabled")?.checked ?? true;
  if (!name) {
    setPluginStatus(tr("validation.tunnelProfileName"), "error");
    return;
  }
  if (tunnelProfileDialog.isNew && !authtoken) {
    setPluginStatus(tr("validation.ngrokAuthtoken"), "error");
    return;
  }
  const profiles = publicTunnelProfiles()
    .filter((profile) => profile.id !== tunnelProfileDialog?.profileId)
    .map(tunnelProfileSaveInputFromSummary);
  profiles.push({
    id: tunnelProfileDialog.profileId,
    provider: "ngrok",
    name,
    enabled,
    authtoken,
  });
  profiles.sort((left, right) => left.name.localeCompare(right.name));
  await saveTunnelProviderProfiles(profiles, "status.tunnelProfileSaved");
}

async function removeTunnelProfile(profileId: string) {
  if (!profileId) return;
  const profiles = publicTunnelProfiles()
    .filter((profile) => profile.id !== profileId)
    .map(tunnelProfileSaveInputFromSummary);
  if (publicTunnel.currentProvider() === `ngrok:${profileId}`) {
    publicTunnel.setProvider("cloudflare-quick");
  }
  await saveTunnelProviderProfiles(profiles, "status.tunnelProfileRemoved");
}

async function saveTunnelProviderProfiles(
  profiles: TunnelProviderProfileSaveInput[],
  successKey: MessageKey,
) {
  const plugin = publicTunnelPlugin();
  if (!plugin || pluginSaveInFlight.has(PUBLIC_TUNNEL_PLUGIN_ID)) return;
  pluginSaveInFlight.add(PUBLIC_TUNNEL_PLUGIN_ID);
  renderPlugins();
  try {
    const response = await capabilityClient.configurePlugin({
      pluginId: PUBLIC_TUNNEL_PLUGIN_ID,
      enabled: plugin.enabled,
      metadata: {
        [TUNNEL_PROVIDER_PROFILES_METADATA]: JSON.stringify(profiles),
      },
    }, { timeoutMs: 10000 });
    const updated = response.plugin ?? plugin;
    plugins = plugins.map((item) => item.id === PUBLIC_TUNNEL_PLUGIN_ID ? updated : item);
    tunnelProfileDialog = undefined;
    syncPublicTunnelProviderSelection();
    setPluginStatus(tr(successKey), "ok");
  } catch (error) {
    setPluginStatus(errorMessage(error), "error");
  } finally {
    pluginSaveInFlight.delete(PUBLIC_TUNNEL_PLUGIN_ID);
    renderPlugins();
  }
}

function tunnelProfileField<T extends HTMLInputElement>(field: string): T | null {
  return elements.pluginList.querySelector<T>(`[data-tunnel-profile-field="${field}"]`);
}

function toggleTunnelTokenVisibility(button: HTMLButtonElement) {
  const shell = button.closest<HTMLElement>(".tunnel-token-input-shell");
  const input = shell?.querySelector<HTMLInputElement>("[data-tunnel-profile-field=\"authtoken\"]");
  if (!input) return;
  const nextVisible = input.type === "password";
  input.type = nextVisible ? "text" : "password";
  const label = tr(nextVisible ? "action.hideToken" : "action.showToken");
  button.setAttribute("aria-label", label);
  button.title = label;
  const icon = button.querySelector<HTMLElement>("[data-lucide]");
  icon?.setAttribute("data-lucide", nextVisible ? "eye-off" : "eye");
  updateIcons();
  input.focus();
}

type ConfigurePluginStatusMode = "toggle" | "settings";

async function configurePlugin(
  pluginId: string,
  enabled: boolean,
  metadata: Record<string, string> = {},
  statusMode: ConfigurePluginStatusMode = "toggle",
): Promise<boolean> {
  const plugin = plugins.find((item) => item.id === pluginId);
  if (!plugin || pluginSaveInFlight.has(pluginId)) return false;
  pluginSaveInFlight.add(pluginId);
  renderPlugins();
  try {
    const response = await capabilityClient.configurePlugin({
      pluginId,
      enabled,
      metadata,
    }, { timeoutMs: 10000 });
    const updated = response.plugin ?? {
      ...plugin,
      enabled,
      metadata: { ...plugin.metadata, ...metadata },
    };
    plugins = plugins.map((item) => item.id === pluginId ? updated : item);
    if (pluginId === PUBLIC_TUNNEL_PLUGIN_ID) {
      syncPublicTunnelProviderSelection();
    }
    if (pluginId === TERMINAL_TRANSFER_PLUGIN_ID && !updated.enabled) {
      terminalTransfer.cancel();
    }
    setPluginStatus(
      statusMode === "settings"
        ? tr("status.pluginSettingsSaved", { name: pluginDisplayName(updated, tr) })
        : tr(enabled ? "status.pluginEnabled" : "status.pluginDisabled", { name: pluginDisplayName(updated, tr) }),
      "ok",
    );
    return true;
  } catch (error) {
    setPluginStatus(
      statusMode === "settings"
        ? tr("status.pluginSettingsSaveFailed", { message: errorMessage(error) })
        : tr(enabled ? "status.pluginEnableFailed" : "status.pluginDisableFailed", { message: errorMessage(error) }),
      "error",
    );
    return false;
  } finally {
    pluginSaveInFlight.delete(pluginId);
    renderPlugins();
  }
}

async function configureTerminalTransferProtocols(protocol: string, checked: boolean) {
  const plugin = plugins.find((item) => item.id === TERMINAL_TRANSFER_PLUGIN_ID);
  if (!plugin || pluginSaveInFlight.has(TERMINAL_TRANSFER_PLUGIN_ID)) return;
  if (protocol !== "lrzsz" && protocol !== "trzsz") return;
  const current = currentTerminalTransferProtocols();
  const requested = protocol === "trzsz"
    ? { ...current, trzsz: checked }
    : { ...current, lrzsz: checked };
  const next = normalizeTerminalTransferProtocols({
    ...requested,
  });
  const saved = await configurePlugin(TERMINAL_TRANSFER_PLUGIN_ID, plugin.enabled, {
    [TERMINAL_TRANSFER_PROTOCOLS_METADATA]: serializeTerminalTransferProtocols(next),
  }, "settings");
  if (saved) terminalTransfer.cancel();
}

function renderPlugins() {
  renderPluginSettings();
  renderPluginTools();
}

function renderPluginSettings() {
  elements.refreshPlugins.disabled = pluginsLoading;
  const mcpServers = parseAiMcpServers(settings.aiMcpServers);
  const tunnelProfiles = publicTunnelProfiles();
  elements.pluginList.innerHTML = renderPluginSettingsView({
    plugins,
    pluginsLoading,
    savingPluginIds: pluginSaveInFlight,
    aiAccess: {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      apiKey: settings.aiApiKey,
      model: settings.aiModel,
      modelOptions: aiChat.modelOptions(),
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
    publicTunnel: {
      profiles: tunnelProfiles,
      dialog: tunnelProfileDialog
        ? {
          profile: tunnelProfileEditor(tunnelProfileDialog, tunnelProfiles),
          isNew: tunnelProfileDialog.isNew,
        }
        : undefined,
      disabled: pluginsLoading || pluginSaveInFlight.has(PUBLIC_TUNNEL_PLUGIN_ID),
      tr,
    },
    terminalTransfer: {
      protocols: currentTerminalTransferProtocols(),
      disabled: pluginsLoading || pluginSaveInFlight.has(TERMINAL_TRANSFER_PLUGIN_ID),
      tr,
    },
    tr,
  });
  updateIcons();
}

function pluginControlsDisabled(plugin: PluginDescriptor): boolean {
  return !plugin.enabled || pluginSaveInFlight.has(plugin.id) || pluginsLoading;
}

function renderPluginTools() {
  const tools = enabledPluginTools(plugins);
  if (!tools.length) {
    activePluginToolId = "";
    elements.pluginToolTabs.innerHTML = "";
    elements.pluginToolBody.innerHTML = renderPluginToolEmpty(pluginsLoading, tr);
    updateIcons();
    return;
  }
  activePluginToolId = resolveActivePluginToolId(tools, activePluginToolId);
  elements.pluginToolTabs.innerHTML = renderPluginToolTabs(tools, activePluginToolId, tr);
  const activePlugin = tools.find((plugin) => plugin.id === activePluginToolId);
  if (activePlugin?.id === FILE_TRANSFER_PLUGIN_ID) {
    fileTransfer.syncPathWithPane();
  }
  elements.pluginToolBody.innerHTML = activePlugin?.id === FILE_TRANSFER_PLUGIN_ID
    ? renderFileTransferTool(activePlugin)
    : activePlugin?.id === AI_CHAT_PLUGIN_ID
      ? renderAIChatTool(activePlugin)
      : activePlugin?.id === LIGHTOS_PORT_FORWARD_PLUGIN_ID
        ? renderLightOsPortForwardTool(activePlugin)
        : activePlugin?.id === POMODORO_PLUGIN_ID
          ? renderPomodoroTool(activePlugin)
          : activePlugin?.id === PUBLIC_TUNNEL_PLUGIN_ID
            ? renderPublicTunnelTool(activePlugin)
            : activePlugin?.id === TERMINAL_TRANSFER_PLUGIN_ID
              ? renderTerminalTransferTool(activePlugin)
      : "";
  updateIcons();
  if (activePlugin?.id === FILE_TRANSFER_PLUGIN_ID) {
    void fileTransfer.loadCurrentDirectoryIfStale();
  }
  if (activePlugin?.id === AI_CHAT_PLUGIN_ID) {
    scrollAIChatToBottom();
  }
  const portForwardState = lightosPortForward.state();
  if (activePlugin?.id === LIGHTOS_PORT_FORWARD_PLUGIN_ID && !portForwardState.loaded && !portForwardState.loading) {
    void lightosPortForward.list();
  }
  const tunnelState = publicTunnel.state();
  if (activePlugin?.id === PUBLIC_TUNNEL_PLUGIN_ID && !tunnelState.loaded && !tunnelState.loading) {
    void publicTunnel.list();
  }
}

function renderFileTransferTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const state = fileTransfer.viewState();
  return renderFileTransferToolView({
    disabled,
    ...state,
    tr,
  });
}

function renderAIChatTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const session = aiChat.ensureSession();
  return renderAIChatToolView({
    disabled,
    title: tr("plugin.aiChat.name"),
    description: pluginDescription(plugin, tr),
    session,
    messages: session.messages,
    streaming: aiChat.isStreaming(),
    modelOptions: aiChat.modelValues(),
    selectedModel: aiChat.currentModel(),
    sessionOptions: aiChat.sessionsForModel(session.model).map((item) => ({ value: item.id, label: item.title })),
    selectedSessionId: aiChat.activeSessionId(),
    providerProfiles: settings.aiProviderProfiles,
    activeProviderProfileId: settings.aiActiveProviderProfileId,
    providerPickerOpen: aiProviderPickerOpen,
    sendTerminalContext: session.sendTerminalContext,
    terminalContextPreview: session.sendTerminalContext ? recentAIContext(activePane()) : "",
    tr,
  });
}

function renderPomodoroTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const viewState = pomodoro.viewState();
  return renderPomodoroToolView(pomodoroToolViewState({
    disabled,
    state: viewState.state,
    draftMinutes: viewState.draftMinutes,
    draftRounds: viewState.draftRounds,
    tr,
    formatDeadline: (date) => formatMobileClockTime(date, {
      locale: settings.locale,
      hour12: !settings.mobileClockUse24Hour,
      showPeriod: !settings.mobileClockUse24Hour && settings.mobileClockShowPeriod,
      showSeconds: false,
    }),
  }));
}

function renderLightOsPortForwardTool(plugin: PluginDescriptor): string {
  const state = lightosPortForward.state();
  return renderLightOsPortForwardToolView({
    disabled: pluginControlsDisabled(plugin),
    remoteHost: state.remoteHost,
    remotePort: state.remotePort,
    forwards: state.forwards,
    loading: state.loading,
    output: state.output,
    tr,
  });
}

function renderPublicTunnelTool(plugin: PluginDescriptor): string {
  publicTunnel.syncProviderSelection();
  const state = publicTunnel.state();
  return renderPublicTunnelToolView({
    disabled: pluginControlsDisabled(plugin),
    provider: state.provider,
    upstreamUrl: state.upstreamUrl,
    ngrokProfiles: publicTunnelProfiles(),
    tunnels: state.tunnels,
    forwards: lightosPortForward.state().forwards,
    loading: state.loading,
    output: state.output,
    tr,
  });
}

function renderTerminalTransferTool(plugin: PluginDescriptor): string {
  return renderTerminalTransferToolView({
    disabled: pluginControlsDisabled(plugin),
    activeBackend: activePane()?.sessionBackend,
    protocols: currentTerminalTransferProtocols(),
    state: terminalTransfer.viewState(),
    tr,
  });
}

function useForwardForTunnel(localUrl: string) {
  if (!localUrl) return;
  publicTunnel.useUpstreamUrl(localUrl);
  activePluginToolId = PUBLIC_TUNNEL_PLUGIN_ID;
  renderPluginTools();
}

async function copyNetworkUrl(url: string) {
  if (!url) return;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
    } else {
      fallbackCopyText(url);
    }
    setPluginStatus(tr("status.urlCopied"), "ok");
  } catch (error) {
    setPluginStatus(tr("status.copyFailed", { message: errorMessage(error) }), "error");
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
  if (aiChat.isStreaming()) return;
  if (!aiProviderProfileById(profileId)) return;
  settings.aiActiveProviderProfileId = profileId;
  syncActiveAiProviderProfile();
  aiProviderPickerOpen = false;
  aiChat.clearModelOptions();
  aiChat.selectSessionForCurrentModel();
  saveSettings();
  renderPlugins();
}

function removeAiProviderProfile(profileId: string) {
  if (aiChat.isStreaming() || settings.aiProviderProfiles.length <= 1) return;
  const nextProfiles = settings.aiProviderProfiles.filter((profile) => profile.id !== profileId);
  if (nextProfiles.length === settings.aiProviderProfiles.length) return;
  settings.aiProviderProfiles = nextProfiles;
  if (settings.aiActiveProviderProfileId === profileId) {
    settings.aiActiveProviderProfileId = nextProfiles[0]?.id ?? "";
  }
  syncActiveAiProviderProfile();
  aiConfigDialog = undefined;
  aiProviderPickerOpen = false;
  aiChat.clearModelOptions();
  aiChat.selectSessionForCurrentModel();
  saveSettings();
  setPluginStatus(tr("status.aiConfigSaved"), "ok");
  renderPlugins();
}

function updateAISetting(field: string, value: string) {
  if (field === "provider") {
    updateActiveAiProviderProfile({
      provider: normalizeAiProviderValue(value),
    });
    aiChat.clearModelOptions();
  } else if (field === "baseUrl") {
    updateActiveAiProviderProfile({
      baseUrl: value.trim(),
    });
    aiChat.clearModelOptions();
  } else if (field === "apiKey") {
    updateActiveAiProviderProfile({
      apiKey: value,
    });
    aiChat.clearModelOptions();
  } else if (field === "model") {
    updateActiveAiProviderProfile({
      model: value.trim(),
    });
    aiChat.selectSessionForCurrentModel();
  } else if (field === "session") {
    aiChat.setActiveSessionId(value);
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
      aiChat.clearModelOptions();
    }
    aiChat.selectSessionForCurrentModel();
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

function pluginIsEnabled(pluginId: string): boolean {
  return plugins.find((plugin) => plugin.id === pluginId)?.enabled ?? false;
}

function terminalTransferPlugin(): PluginDescriptor | undefined {
  return plugins.find((plugin) => plugin.id === TERMINAL_TRANSFER_PLUGIN_ID);
}

function currentTerminalTransferProtocols() {
  return terminalTransferProtocolsFromMetadata(terminalTransferPlugin()?.metadata);
}

function aiAccessConfigured(): boolean {
  return Boolean(settings.aiBaseUrl.trim() && settings.aiApiKey.trim());
}

async function terminalAIContext(includeTerminalContext: boolean): Promise<Record<string, unknown>> {
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
  if (!includeTerminalContext || !pane) {
    return context;
  }
  context.context_lines = AI_TERMINAL_CONTEXT_LINES;
  context.context_source = pane.sessionBackend === "herdr" ? "herdr.sockapi" : "terminal.buffer";
  if (pane.sessionBackend === "herdr") {
    await appendHerdrAIContext(context, pane, {
      lines: AI_TERMINAL_CONTEXT_LINES,
      ensureHerdrSocketReady,
      currentHerdrPaneId,
      runHerdrSocketRequest,
    });
  } else {
    context.recent_output = recentAIContext(pane);
  }
  return context;
}

function recentAIContext(pane: TerminalPane | undefined): string {
  return recentAIContextForPane(pane, AI_TERMINAL_CONTEXT_LINES);
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
  const session = aiChat.activeSession();
  if (!session?.sendTerminalContext) return;
  const preview = document.querySelector<HTMLElement>(".ai-context-lcd pre");
  if (!preview) return;
  preview.textContent = recentAIContext(pane).trim().split(/\r?\n/).slice(-12).join("\n");
  preview.scrollTop = preview.scrollHeight;
}

function observeWorkingDirectory(pane: TerminalPane, text: string) {
  const fromOsc = workingDirectoryFromOsc7(text);
  const fromPrompt = fromOsc || workingDirectoryFromPrompt(text);
  if (!fromPrompt) return;
  pane.workingDirectory = fromPrompt;
  if (pane.id === activePane()?.id && activePluginToolId === FILE_TRANSFER_PLUGIN_ID) {
    fileTransfer.syncObservedPane(pane.id);
  }
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
    pinned?: boolean;
    pinnedOrder?: number;
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
    pinned: options.pinned,
    pinnedOrder: options.pinnedOrder,
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
    refreshHerdrTerminalAfterAction(selector, action);
    focusActivePaneCanvas();
  } catch (error) {
    elements.herdrStatus.textContent = tr("status.herdrActionFailed", { message: errorMessage(error) });
  }
}

function refreshHerdrTerminalAfterAction(selector: string, action: HerdrAction) {
  if (!herdrActionChangesVisibleScreen(action)) return;
  const match = findPaneBySessionBackend(selector, "herdr");
  if (!match) return;
  refreshHerdrPaneTerminalAfterAction(match.pane);
}

function herdrActionChangesVisibleScreen(action: HerdrAction): boolean {
  return action === "focus_workspace"
    || action === "focus_tab"
    || action === "create_workspace"
    || action === "create_tab"
    || action === "close_workspace";
}

function refreshHerdrPaneTerminal(pane: TerminalPane) {
  if (!isHerdrTerminalPane(pane) || !canConnectPanePty(pane)) return;
  if (pane.socket?.readyState === WebSocket.OPEN) {
    refreshPaneTerminalSize(pane);
    return;
  }
  if (pane.socket?.readyState !== WebSocket.CONNECTING) {
    connectPanePty(pane);
  }
}

function refreshHerdrPaneTerminalAfterAction(pane: TerminalPane) {
  refreshHerdrPaneTerminal(pane);
  for (const delay of HERDR_FOCUS_REFRESH_DELAYS_MS) {
    window.setTimeout(() => refreshHerdrPaneTerminal(pane), delay);
  }
  focusPaneCanvas(pane);
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
  const shouldSubscribe = Boolean(selector && herdrState?.available && activeHerdrTerminalPane());
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
  if (event === "pane.agent_detected" || event === "pane.agent_status_changed") {
    mobileSymbolAgent.invalidate();
    void mobileSymbolAgent.refresh();
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
  const showHerdrControls = hasHerdrControls && Boolean(activeHerdrTerminalPane());
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
    renderHerdrProtocolNotice(undefined);
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
  renderHerdrProtocolNotice(herdrState);
  renderHerdrWorkspaceMenu();
  void syncHerdrEventBridge();
  updateIcons();
}

function renderHerdrProtocolNotice(state: HerdrBridgeState | undefined) {
  const notice = herdrProtocolNotice(state);
  if (!notice) {
    elements.herdrProtocolNotice.hidden = true;
    elements.herdrProtocolNotice.removeAttribute("data-state");
    elements.herdrProtocolNotice.removeAttribute("title");
    elements.herdrProtocolNotice.removeAttribute("aria-label");
    return;
  }
  elements.herdrProtocolNotice.hidden = false;
  elements.herdrProtocolNotice.dataset.state = notice.state;
  elements.herdrProtocolNotice.title = notice.message;
  elements.herdrProtocolNotice.setAttribute("aria-label", notice.message);
}

function herdrProtocolNotice(
  state: HerdrBridgeState | undefined,
): { state: "newer" | "older"; message: string } | undefined {
  const actual = state?.herdr_protocol;
  const expected = state?.supported_protocol;
  if (typeof actual !== "number" || typeof expected !== "number" || actual === expected) return undefined;
  const expectedVersion = state?.supported_herdr_version || "?";
  const params = {
    actual: String(actual),
    expected: String(expected),
    expectedVersion,
  };
  if (actual > expected) {
    return { state: "newer", message: tr("status.herdrProtocolNewer", params) };
  }
  return { state: "older", message: tr("status.herdrProtocolOlder", params) };
}

function findPaneBySessionBackend(
  selector: string,
  mode: SessionMode,
): { tab: TerminalTab; pane: TerminalPane } | undefined {
  return findSessionBackendPane(tabs, selector, mode);
}

function activeHerdrTerminalPane(): TerminalPane | undefined {
  const tab = activeTab();
  return selectHerdrTerminalPane(tab, activePane(tab));
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
    prepareMobileOverlay();
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
  elements.newTabMenu.style.right = "";
  elements.newTabMenu.style.bottom = "";
  if (isMobileOverlayMode()) {
    return;
  }
  elements.newTabMenu.style.right = "auto";
  elements.newTabMenu.style.bottom = "auto";
  requestAnimationFrame(() => {
    if (elements.newTabMenu.hidden || isMobileOverlayMode()) return;
    const margin = 8;
    const buttonRect = elements.newTabButton.getBoundingClientRect();
    const menuRect = elements.newTabMenu.getBoundingClientRect();
    const bounds = floatingViewportBounds(margin);
    const vertical = elements.webshell.dataset.tabLayout === "vertical";
    const preferredLeft = vertical
      ? buttonRect.right + 8
      : buttonRect.right - menuRect.width;
    const fallbackLeft = buttonRect.left - menuRect.width - 8;
    const maxLeft = Math.max(bounds.minLeft, bounds.maxLeft - menuRect.width);
    const maxTop = Math.max(bounds.minTop, bounds.maxTop - menuRect.height);
    const unclampedLeft = vertical && preferredLeft > maxLeft ? fallbackLeft : preferredLeft;
    const top = vertical ? buttonRect.top : buttonRect.bottom + 8;
    elements.newTabMenu.style.left = `${clamp(unclampedLeft, bounds.minLeft, maxLeft)}px`;
    elements.newTabMenu.style.top = `${clamp(top, bounds.minTop, maxTop)}px`;
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
  prepareMobileOverlay();
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
    tab.pinned = tabState.pinned === true;
    tab.pinnedOrder = typeof tabState.pinned_order === "number" ? tabState.pinned_order : undefined;
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
  const nextBackend = normalizeSessionMode(paneState.session_backend);
  let pane: TerminalPane;
  if (
    existing
    && existing.sessionId === paneState.session_id
    && existing.sessionBackend === nextBackend
  ) {
    pane = existing;
    if (options.replayFromStart) {
      preparePaneForFullReplay(pane);
    }
  } else {
    if (existing) {
      disposePaneLocal(existing);
    }
    pane = makePane(tab, paneState.id);
  }
  pane.tabId = tab.id;
  pane.selector = tab.selector;
  pane.label = tab.label;
  pane.sessionId = paneState.session_id;
  pane.sessionStatus = paneState.status;
  pane.sessionBackend = nextBackend;
  restoreHerdrOutputSequence(pane, paneState.herdr_output_sequence);
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
  terminalTransfer.resetPane(pane);
  flushPaneDecoder(pane);
  disposePaneTerminalRuntime(pane);
  destroyPaneTransport(pane);
  pane.lastReplayAfter = undefined;
  pane.lastOutputSequence = 0;
  pane.titleBuffer = "";
  clearPendingInput(pane);
}

function restoreHerdrOutputSequence(pane: TerminalPane, sequence: unknown) {
  if (pane.sessionBackend !== "herdr" || !pane.sessionId) return;
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return;
  const remembered = Math.max(0, Math.trunc(sequence));
  if (remembered > pane.lastOutputSequence) {
    pane.lastOutputSequence = remembered;
  }
}

function shouldConnectRestoredPane(pane: TerminalPane): boolean {
  if (!pane.sessionId) return false;
  if (pane.sessionStatus === "closed") return false;
  if (isHerdrTerminalPane(pane)) return true;
  if (pane.sessionStatus === "exited") return false;
  if (pane.sessionStatus === "running" || pane.sessionStatus === "starting") return true;
  if (pane.sessionStatus === "stopped") return true;
  return settings.autoRestartSessions;
}

function isHerdrTerminalPane(pane: TerminalPane): boolean {
  return pane.sessionBackend === "herdr";
}

function canConnectPanePty(pane: TerminalPane): boolean {
  if (pane.closing || !pane.sessionId) return false;
  return !pane.exited || shouldConnectRestoredPane(pane);
}

function shouldRestartSessionOnConnect(pane: TerminalPane): boolean {
  return settings.autoRestartSessions || isHerdrTerminalPane(pane);
}

async function connectRestoredPanes() {
  for (const pane of allPanes()) {
    if (!canConnectPanePty(pane)) continue;
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
    pinned: false,
    pinnedOrder: undefined,
    closing: false,
  };
}

function makePane(tab: TerminalTab, restoredId?: string): TerminalPane {
  const id = restoredId || newId();
  const mount = createTerminalPaneMount(id, `${tab.label} pane`, {
    onPointerDown: (event) => {
      const current = findPaneById(id);
      if (current) {
        mobileTerminalGestures.trackSwipeStart(current.id, event);
        activatePane(current.tabId, id, { focus: false });
        if (shouldFocusTerminalFromPointer(event)) {
          requestAnimationFrame(() => focusPaneCanvas(current, { force: true }));
        }
      }
    },
    onPointerUp: (event) => {
      if (event.pointerType !== "touch") return;
      const current = findPaneById(id);
      const gesture = current ? mobileTerminalGestures.readGesture(current.id, event) : undefined;
      if (current && gesture && mobileTerminalGestures.runSwipe(gesture)) {
        mobileTerminalGestures.clearGesture();
        event.preventDefault();
        return;
      }
      mobileTerminalGestures.clearGesture();
      if (current && gesture && mobileTerminalGestures.isTapGesture(gesture) && mobileTerminalGestures.isDoubleTap(current.id, event)) {
        event.preventDefault();
        focusPaneSystemKeyboard(current);
      }
    },
    onPointerCancel: (event) => {
      if (event.pointerType === "touch") {
        mobileTerminalGestures.clearGesture();
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
      paneMenuController.open(event.clientX, event.clientY, id);
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
  applyThemeToMount(mount, currentAppearanceContext());
  return pane;
}

function createPaneRuntimeTransport(pane: TerminalPane) {
  return createPaneTransport(pane, {
    updateSize: updatePaneTerminalSize,
    openSocket,
    sendInput: sendPaneInput,
    resize: sendPaneResize,
  });
}

async function createPane(tab: TerminalTab, placement: SplitPlacement) {
  const pane = activePane(tab);
  const herdrPane = selectHerdrTerminalPane(tab, pane);
  if (herdrPane) {
    if (!herdrSplitDirection(placement)) return;
    try {
      await splitHerdrPane(herdrPane, placement);
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
  disposePaneTerminalRuntime(pane);
  const transport = replacePaneTransport(pane, createPaneRuntimeTransport);
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
    transport,
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
    focusPaneCanvas(pane);
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
  terminalTransfer.resizePane(pane, pane.cols);
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
  if (!canConnectPanePty(pane)) return;
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
  const replayAfter = replayAfterForPane(pane);
  pane.lastReplayAfter = replayAfter;
  const url = webshellTerminalSocketUrl({
    selector: pane.selector,
    sessionId: pane.sessionId,
    paneId: pane.id,
    sessionBackend: pane.sessionBackend,
    cols: pane.cols || pane.term?.cols || INITIAL_COLS,
    rows: pane.rows || pane.term?.rows || INITIAL_ROWS,
    restart: shouldRestartSessionOnConnect(pane),
    after: replayAfter,
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
      focusPaneCanvas(pane);
    }
  });
  socket.addEventListener("message", (event) => {
    if (pane.socket === socket) handleSocketMessage(pane, event);
  });
  socket.addEventListener("close", () => {
    if (pane.socket !== socket) return;
    terminalTransfer.resetPane(pane, tr("status.socketError"));
    clearReplayInputLock(pane);
    flushPaneDecoder(pane);
    pane.transport?.notifyDisconnect();
    scheduleReconnect(pane);
  });
  socket.addEventListener("error", () => {
    if (pane.socket !== socket) return;
    terminalTransfer.resetPane(pane, tr("status.socketError"));
    clearReplayInputLock(pane);
    pane.transport?.notifyError(tr("status.socketError"));
    setPaneStatus(pane, tr("status.socketError"), "error");
  });
}

function replayAfterForPane(pane: TerminalPane): number {
  const sequence = Number.isFinite(pane.lastOutputSequence) ? Math.max(0, Math.trunc(pane.lastOutputSequence)) : 0;
  if (pane.sessionBackend !== "herdr" || sequence <= 0) return sequence;
  return Math.max(0, sequence - HERDR_REPLAY_TAIL_FRAMES);
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

function updatePaneOutputSequence(
  pane: TerminalPane,
  sequence: unknown,
  options: { allowReset?: boolean } = {},
) {
  if (typeof sequence !== "number" || !Number.isFinite(sequence)) return;
  const next = Math.max(0, Math.trunc(sequence));
  const replayAfter = pane.lastReplayAfter ?? 0;
  if (
    pane.sessionBackend === "herdr"
    && options.allowReset
    && replayAfter > 0
    && next < replayAfter
    && next < pane.lastOutputSequence
  ) {
    pane.lastOutputSequence = next;
  } else {
    pane.lastOutputSequence = monotonicSequence(pane.lastOutputSequence, next);
  }
  scheduleRememberHerdrOutputSequence(pane);
}

function scheduleRememberHerdrOutputSequence(pane: TerminalPane) {
  if (pane.sessionBackend !== "herdr" || !pane.sessionId || !pane.selector) return;
  const sequence = Number.isFinite(pane.lastOutputSequence) ? Math.max(0, Math.trunc(pane.lastOutputSequence)) : 0;
  const sessionId = pane.sessionId;
  pendingHerdrOutputSequences.set(sessionId, { selector: pane.selector, sequence });
  if (herdrOutputSequenceTimers.has(sessionId)) return;
  const timer = window.setTimeout(() => {
    herdrOutputSequenceTimers.delete(sessionId);
    const pending = pendingHerdrOutputSequences.get(sessionId);
    pendingHerdrOutputSequences.delete(sessionId);
    if (pending !== undefined) {
      void persistHerdrOutputSequence(pending.selector, sessionId, pending.sequence);
    }
  }, HERDR_OUTPUT_SEQUENCE_FLUSH_DELAY_MS);
  herdrOutputSequenceTimers.set(sessionId, timer);
}

function flushHerdrOutputSequences() {
  for (const timer of herdrOutputSequenceTimers.values()) {
    window.clearTimeout(timer);
  }
  herdrOutputSequenceTimers.clear();
  for (const pane of allPanes()) {
    if (pane.sessionBackend === "herdr" && pane.sessionId && pane.selector) {
      const sequence = Number.isFinite(pane.lastOutputSequence) ? Math.max(0, Math.trunc(pane.lastOutputSequence)) : 0;
      pendingHerdrOutputSequences.set(pane.sessionId, { selector: pane.selector, sequence });
    }
  }
  for (const [sessionId, pending] of pendingHerdrOutputSequences) {
    void persistHerdrOutputSequence(pending.selector, sessionId, pending.sequence, { keepalive: true });
  }
  pendingHerdrOutputSequences.clear();
}

async function persistHerdrOutputSequence(
  selector: string,
  sessionId: string,
  sequence: number,
  options: { keepalive?: boolean } = {},
) {
  const normalizedSelector = normalizeSelector(selector);
  const normalizedSessionId = normalizeSelector(sessionId);
  if (!normalizedSelector || !normalizedSessionId || !Number.isFinite(sequence) || sequence < 0) return;
  const normalizedSequence = Math.max(0, Math.trunc(sequence));
  if (options.keepalive && navigator.sendBeacon) {
    const payload = JSON.stringify({
      name: normalizedSelector,
      session_id: normalizedSessionId,
      sequence: normalizedSequence,
    });
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon(new URL("./api/herdr/output-sequence", window.location.href), blob)) {
      return;
    }
  }
  try {
    const stored = await saveHerdrOutputSequence(
      normalizedSelector,
      normalizedSessionId,
      normalizedSequence,
      { keepalive: options.keepalive },
    );
    for (const pane of allPanes()) {
      if (pane.sessionId === normalizedSessionId && pane.sessionBackend === "herdr") {
        pane.lastOutputSequence = monotonicSequence(pane.lastOutputSequence, stored);
      }
    }
  } catch (error) {
    if (settings.debugMode) {
      console.debug("failed to persist Herdr output sequence", error);
    }
  }
}

function handleSocketMessage(pane: TerminalPane, event: MessageEvent) {
  if (pane.closing) return;
  if (event.data instanceof ArrayBuffer) {
    handleTerminalBytes(pane, new Uint8Array(event.data));
    return;
  }
  if (event.data instanceof Blob) {
    event.data.arrayBuffer().then((buffer) => {
      if (!pane.closing) handleTerminalBytes(pane, new Uint8Array(buffer));
    });
    return;
  }
  handleServerText(pane, String(event.data));
}

function handleTerminalBytes(pane: TerminalPane, bytes: Uint8Array) {
  if (terminalTransfer.consumePaneOutput(pane, bytes)) return;
  writeTerminalBytes(pane, bytes);
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
    if (typeof event.replay_after === "number" && Number.isFinite(event.replay_after)) {
      pane.lastReplayAfter = Math.max(0, Math.trunc(event.replay_after));
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
    updatePaneOutputSequence(pane, event.sequence);
  } else if (event.type === "replay-complete") {
    if (!matchesPaneReplay(pane, event)) {
      clearReplayInputLock(pane);
      pane.socket?.close();
      setPaneStatus(pane, tr("status.terminalError"), "error");
      return;
    }
    updatePaneOutputSequence(pane, event.last_sequence, { allowReset: true });
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
  if (!canConnectPanePty(pane)) return;
  if (pane.sessionStatus !== "running" && !settings.autoRestartSessions && !isHerdrTerminalPane(pane)) {
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
  focusActivePaneCanvas();
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
    focusPaneCanvas(activePane(tab));
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
  if (!aiChat.activeSession()?.sendTerminalContext) return;
  renderPluginTools();
}

function renderTabs() {
  updateTabChrome();
  elements.tabList.innerHTML = renderTabsView(tabViewItems(), {
    empty: tr("status.noSessions"),
    rename: tr("action.renameTab"),
    close: tr("action.closeTab"),
    pin: tr("action.pinTab"),
    unpin: tr("action.unpinTab"),
    movePinnedPrevious: tr("action.movePinnedTabPrevious"),
    movePinnedNext: tr("action.movePinnedTabNext"),
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
  const pinned = sortedPinnedTabs();
  return tabs.map((tab) => {
    const displayName = tabDisplayName(tab);
    const pinnedIndex = tab.pinned ? pinned.findIndex((item) => item.id === tab.id) : -1;
    return {
      id: tab.id,
      active: tab.id === activeTabId,
      renaming: renamingTabId === tab.id,
      named: !tab.pinned && tabHasTextTitle(tab, displayName),
      pinned: tab.pinned,
      pinnedGlyph: tabPinnedGlyph(tab, displayName),
      canMovePinnedPrevious: pinnedIndex > 0,
      canMovePinnedNext: pinnedIndex >= 0 && pinnedIndex < pinned.length - 1,
      displayName,
      title: tab.pinned ? displayName : tabCurrentTitle(tab),
      tone: tabTone(tab),
    };
  });
}

function updateTabChrome() {
  elements.webshell.classList.toggle("has-named-tabs", tabs.some((tab) => !tab.pinned && tabHasTextTitle(tab, tabDisplayName(tab))));
  elements.webshell.classList.toggle("has-pinned-tabs", tabs.some((tab) => tab.pinned));
}

function tabDisplayName(tab: TerminalTab): string {
  return displayNameForTab(tab, tabs, tr, herdrWorkspaceLabelForTab);
}

function tabHasTextTitle(tab: TerminalTab, displayName = tabDisplayName(tab)): boolean {
  return tabHasDisplayTextTitle(tab, displayName);
}

function tabPinnedGlyph(tab: TerminalTab, displayName = tabDisplayName(tab)): string {
  return pinnedGlyphForTab(tab, displayName);
}

function sortedPinnedTabs(): TerminalTab[] {
  return sortPinnedTabs(tabs);
}

function herdrWorkspaceLabelForTab(tab: TerminalTab): string {
  if (!isHerdrTab(tab)) return "";
  if (normalizeSelector(herdrState?.selector) !== normalizeSelector(tab.selector)) {
    return tr("backend.herdr");
  }
  const workspace = focusedHerdrWorkspace();
  return workspace?.label.trim() || tr("backend.herdr");
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
  const defaultName = defaultDisplayNameForTab(tab, tabs, tr);
  if (isHerdrTab(tab)) {
    tab.customTitle = undefined;
    renderTabs();
    updateActiveDetails();
    focusActivePaneCanvas();
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
  focusActivePaneCanvas();
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
  focusActivePaneCanvas();
}

async function toggleTabPinned(tabId: string) {
  const tab = tabs.find((item) => item.id === tabId);
  if (!tab) return;
  try {
    await runWorkspaceAction("set_tab_pinned", {
      selector: tab.selector,
      tabId,
      pinned: !tab.pinned,
    });
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
}

async function movePinnedTab(tabId: string, direction: -1 | 1) {
  const pinned = sortedPinnedTabs();
  const index = pinned.findIndex((tab) => tab.id === tabId);
  const tab = pinned[index];
  const neighbor = pinned[index + direction];
  if (!tab || !neighbor) return;
  const currentOrder = tab.pinnedOrder ?? index;
  const neighborOrder = neighbor.pinnedOrder ?? index + direction;
  const temporaryOrder = Math.max(currentOrder, neighborOrder, ...pinned.map((item, fallback) => item.pinnedOrder ?? fallback)) + 1;
  try {
    await runWorkspaceAction("set_tab_pinned", {
      selector: tab.selector,
      tabId: tab.id,
      pinned: true,
      pinnedOrder: temporaryOrder,
      apply: false,
    });
    await runWorkspaceAction("set_tab_pinned", {
      selector: neighbor.selector,
      tabId: neighbor.id,
      pinned: true,
      pinnedOrder: currentOrder,
      apply: false,
    });
    await runWorkspaceAction("set_tab_pinned", {
      selector: tab.selector,
      tabId: tab.id,
      pinned: true,
      pinnedOrder: neighborOrder,
    });
  } catch (error) {
    setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
  }
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
  tab.closing = true;
  for (const pane of tab.panes) {
    pane.closing = true;
  }
  try {
    await runWorkspaceAction("close_tab", { selector: tab.selector, tabId });
  } catch (error) {
    tab.closing = false;
    for (const pane of tab.panes) {
      pane.closing = false;
    }
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
  flushPaneDecoder(pane);
  clearPendingInput(pane);
  disposePaneTerminalRuntime(pane);
  destroyPaneTransport(pane);
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
    mobileSymbolAgent.reset();
    return;
  }

  elements.emptyState.hidden = true;
  elements.targetLabel.textContent = selectorLabel(tab.selector);
  elements.instanceStatusDot.dataset.status = instanceForSelector(tab.selector)?.status ?? "running";
  setGlobalStatus(pane.status, pane.tone);
  document.title = `${tabCurrentTitle(tab)} - ${tr("app.title")}`;
  void mobileSymbolAgent.refresh();
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

function shouldFocusTerminalFromPointer(event: PointerEvent): boolean {
  return !isCoarseTouchPointer(event);
}

function focusActivePaneCanvas(options: { force?: boolean } = {}) {
  focusPaneCanvas(activePane(), options);
}

function focusAfterMobileShortcut() {
  if (isCoarseTouchPointer()) return;
  focusActivePaneCanvas();
}

function focusActivePaneSystemKeyboard() {
  const pane = activePane();
  if (pane) focusPaneSystemKeyboard(pane);
}

function focusPaneCanvas(pane: TerminalPane | undefined, options: { force?: boolean } = {}) {
  if (!pane) return;
  if (!options.force && shouldPreserveOverlayEditableFocus()) return;
  if (!isCoarseTouchPointer() && focusPaneImeInput(pane)) return;
  if (isCoarseTouchPointer()) {
    const canvas = pane.term?.restty?.activePane()?.getRawPane().canvas;
    if (canvas instanceof HTMLElement) {
      canvas.focus({ preventScroll: true });
      return;
    }
  }
  pane.term?.focus();
}

function shouldPreserveOverlayEditableFocus(): boolean {
  return (!elements.pluginSidebar.hidden && activeEditableElementIn(elements.pluginSidebar))
    || (!elements.settingsPage.hidden && activeEditableElementIn(elements.settingsPage))
    || (!elements.notificationModal.hidden && activeEditableElementIn(elements.notificationModal));
}

function focusPaneSystemKeyboard(pane: TerminalPane) {
  activatePane(pane.tabId, pane.id, { focus: false });
  if (!focusPaneImeInput(pane)) {
    pane.term?.focus();
  }
  handleViewportChange();
}

function handleTerminalImeFocusCapture(event: KeyboardEvent) {
  const pane = paneForEventTarget(event.target);
  if (!pane) return;
  preparePaneImeForKeyboardEvent(pane, event);
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
  focusPaneCanvas(pane);
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

function sendPaneBytes(pane: TerminalPane, bytes: Uint8Array): boolean {
  if (!pane || !canConnectPanePty(pane)) return false;
  if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying || pane.closing) return false;
  pane.socket.send(bytes);
  return true;
}

function sendHistoryRecording(pane: TerminalPane, enabled: boolean) {
  if (pane.socket?.readyState !== WebSocket.OPEN || pane.closing) return;
  pane.socket.send(webshellHistoryRecordingMessage(enabled));
}

function sendPaneInput(pane: TerminalPane, data: string): boolean {
  if (!pane || !canConnectPanePty(pane)) {
    focusActivePaneCanvas();
    return false;
  }
  if (terminalTransfer.consumePaneInput(pane, data)) {
    return true;
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
    focusActivePaneCanvas();
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
  return selectActiveTab(tabs, activeTabId);
}

function activePane(tab = activeTab()): TerminalPane | undefined {
  return selectActivePane(tab);
}

function allPanes(): TerminalPane[] {
  return allTabPanes(tabs);
}

function visiblePanes(tab: TerminalTab): TerminalPane[] {
  return visibleTabPanes(tab);
}

function findPaneById(id: string): TerminalPane | undefined {
  return findPaneByIdInTabs(tabs, id);
}

function tabForPane(pane: TerminalPane): TerminalTab | undefined {
  return tabForPaneInTabs(tabs, pane);
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
        focusPaneCanvas(pane);
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
    focusPaneCanvas(pane);
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
  focusPaneCanvas(pane);
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
  return toneForTab(tab, activePane(tab));
}

function tabCurrentTitle(tab: TerminalTab): string {
  return currentTabTitle(tab, activePane(tab));
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
