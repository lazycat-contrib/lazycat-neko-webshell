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
import { encodeMobileShortcutKeyInput } from "./keyboard";
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
const MAX_AI_CONTEXT_CHARS = 12000;
const LAST_SELECTOR_STORAGE_KEY = "lazycat-neko-webshell.lastSelector";
const LAST_TAB_STORAGE_PREFIX = "lazycat-neko-webshell.lastTab";
const LIGHT_INTERFACE_STYLES = new Set<InterfaceStyleId>(["porcelain", "frost", "champagne", "candy", "lab"]);
const capabilityClient = createClient(
  CapabilityService,
  createConnectTransport({
    baseUrl: "/",
    fetch: (input, init) => fetch(input, { ...init, credentials: "same-origin" }),
  }),
);
const actionClient = new TerminalActionWSClient();

type SessionMode = SessionBackendId;
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
  elements.pluginToolBody.addEventListener("change", (event) => {
    const upload = event.target instanceof Element
      ? event.target.closest<HTMLInputElement>("#fileTransferUpload")
      : null;
    const file = upload?.files?.[0];
    if (!upload || !file) return;
    void uploadFileTransfer(file).finally(() => {
      upload.value = "";
    });
  });
  elements.pluginToolBody.addEventListener("click", (event) => {
    const fileButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-file-transfer-action]")
      : null;
    if (fileButton) {
      void runFileTransfer(fileButton.dataset.fileTransferAction ?? "");
      return;
    }
    const aiButton = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-ai-action]")
      : null;
    if (!aiButton) return;
    const action = aiButton.dataset.aiAction ?? "";
    if (action === "insert-output") {
      insertAIOutputIntoTerminal();
    } else if (action === "copy-output") {
      void copyAIOutput();
    } else if (action === "clear-output") {
      clearAIOutput();
    } else {
      void runAIAction(action);
    }
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
  elements.pluginsButton.addEventListener("click", (event) => {
    event.stopPropagation();
    openPluginSidebar();
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
      closeSettings();
      closePluginSidebar();
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
  if (shortcut === "ctrl" || shortcut === "alt" || shortcut === "shift") {
    mobileSticky[shortcut] = !mobileSticky[shortcut];
    updateMobileShortcutState();
    focusActivePaneCanvas();
    return;
  }

  if (shortcut === "paste") {
    await pasteIntoPane(activePane(), false);
    clearMobileSticky();
    focusActivePaneCanvas();
    return;
  }

  const data = encodeMobileShortcutKeyInput(shortcut, mobileSticky);
  if (data) {
    sendActivePaneKeyInput(data);
  }
  if (!options.keepModifiers) {
    clearMobileSticky();
  }
  focusActivePaneCanvas();
}

function runMobileChord(chord: string) {
  const data = mobileChordInput(chord);
  if (data) {
    sendActivePaneKeyInput(data);
  }
  clearMobileSticky();
  focusActivePaneCanvas();
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
    focusActivePaneCanvas();
  }
}

function mobileChordInput(chord: string): string | undefined {
  if (chord === "ctrl-c") return "\x03";
  if (chord === "ctrl-e") return "\x05";
  if (chord === "shift-tab") return "\x1b[Z";
  return undefined;
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
  const promote = elements.paneMenu.querySelector<HTMLButtonElement>('[data-pane-action="promote-session-to-tab"]');
  if (promote) {
    promote.hidden = !tab || visiblePanes(tab).length <= 1;
  }
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
  const settingsTool = plugin.id === "ai-control" ? renderAIAccessSettings(plugin) : "";
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
  const tools = plugins.filter((plugin) => plugin.enabled && (plugin.id === "file-transfer" || plugin.id === "ai-control"));
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
    <button type="button" role="tab" data-plugin-tool="${escapeAttr(plugin.id)}" aria-selected="${plugin.id === activePluginToolId}">
      <i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i>
      <span>${escapeHtml(pluginDisplayName(plugin))}</span>
    </button>
  `).join("");
  const activePlugin = tools.find((plugin) => plugin.id === activePluginToolId);
  elements.pluginToolBody.innerHTML = activePlugin?.id === "file-transfer"
    ? renderFileTransferTool(activePlugin)
    : activePlugin?.id === "ai-control"
      ? renderAIControlTool(activePlugin)
      : "";
  updateIcons();
}

function renderFileTransferTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const disabledAttr = disabled ? "disabled" : "";
  return `
    <div class="plugin-tool file-transfer-tool">
      <div class="settings-group-title">${escapeHtml(tr("section.fileTransfer"))}</div>
      <p class="settings-help">${escapeHtml(tr("plugin.fileTransfer.help"))}</p>
      <label class="field">
        <span>${escapeHtml(tr("field.pluginPath"))}</span>
        <input id="fileTransferPath" type="text" value="/" autocomplete="off" spellcheck="false" ${disabledAttr} />
      </label>
      <div class="plugin-action-row">
        <button class="command-button" type="button" data-file-transfer-action="list" ${disabledAttr}>
          <i data-lucide="list-tree"></i>
          <span>${escapeHtml(tr("action.pluginFileList"))}</span>
        </button>
        <button class="command-button" type="button" data-file-transfer-action="read" ${disabledAttr}>
          <i data-lucide="file-text"></i>
          <span>${escapeHtml(tr("action.pluginFileRead"))}</span>
        </button>
        <button class="command-button" type="button" data-file-transfer-action="stat" ${disabledAttr}>
          <i data-lucide="info"></i>
          <span>${escapeHtml(tr("action.pluginFileStat"))}</span>
        </button>
        <button class="command-button" type="button" data-file-transfer-action="download" ${disabledAttr}>
          <i data-lucide="download"></i>
          <span>${escapeHtml(tr("action.pluginFileDownload"))}</span>
        </button>
        <label class="file-button ${disabled ? "is-disabled" : ""}">
          <input id="fileTransferUpload" type="file" ${disabledAttr} />
          <i data-lucide="upload"></i>
          <span>${escapeHtml(tr("action.pluginFileUpload"))}</span>
        </label>
      </div>
      <pre class="plugin-output" id="fileTransferOutput" aria-label="${escapeAttr(tr("plugin.fileTransfer.output"))}"></pre>
    </div>
  `;
}

function renderAIControlTool(plugin: PluginDescriptor): string {
  const disabled = pluginControlsDisabled(plugin);
  const disabledAttr = disabled ? "disabled" : "";
  return `
    <div class="plugin-tool ai-control-tool">
      <div class="settings-group-title">${escapeHtml(tr("plugin.aiControl.name"))}</div>
      <div class="plugin-action-row ai-action-row">
        <button class="command-button" type="button" data-ai-action="chat" ${disabledAttr}>
          <i data-lucide="message-square"></i>
          <span>${escapeHtml(tr("action.aiChat"))}</span>
        </button>
        <button class="command-button" type="button" data-ai-action="nl2cmd" ${disabledAttr}>
          <i data-lucide="terminal"></i>
          <span>${escapeHtml(tr("action.aiNl2cmd"))}</span>
        </button>
        <button class="command-button" type="button" data-ai-action="complete" ${disabledAttr}>
          <i data-lucide="wand-sparkles"></i>
          <span>${escapeHtml(tr("action.aiComplete"))}</span>
        </button>
        <button class="command-button" type="button" data-ai-action="explain" ${disabledAttr}>
          <i data-lucide="circle-help"></i>
          <span>${escapeHtml(tr("action.aiExplain"))}</span>
        </button>
        <button class="command-button" type="button" data-ai-action="insert-output" ${disabledAttr}>
          <i data-lucide="corner-down-left"></i>
          <span>${escapeHtml(tr("action.aiInsert"))}</span>
        </button>
      </div>
      <label class="field ai-prompt-field">
        <span>${escapeHtml(tr("field.aiPrompt"))}</span>
        <textarea id="aiPrompt" rows="4" spellcheck="false" ${disabledAttr}></textarea>
      </label>
      <div class="ai-block">
        <div class="ai-block-head">
          <span><i data-lucide="bot"></i>${escapeHtml(tr("plugin.aiControl.block"))}</span>
          <div class="ai-block-actions">
            <button class="icon-button" type="button" data-ai-action="copy-output" aria-label="${escapeAttr(tr("action.aiCopy"))}" title="${escapeAttr(tr("action.aiCopy"))}" ${disabledAttr}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button" type="button" data-ai-action="clear-output" aria-label="${escapeAttr(tr("action.aiClear"))}" title="${escapeAttr(tr("action.aiClear"))}" ${disabledAttr}>
              <i data-lucide="x"></i>
            </button>
          </div>
        </div>
        <pre class="plugin-output ai-output" id="aiOutput" aria-label="${escapeAttr(tr("plugin.aiControl.output"))}"></pre>
      </div>
    </div>
  `;
}

async function runFileTransfer(action: string) {
  if (action !== "list" && action !== "read" && action !== "stat" && action !== "download") return;
  if (!pluginIsEnabled("file-transfer")) return;
  const path = fileTransferPath();
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

async function uploadFileTransfer(file: File) {
  if (!pluginIsEnabled("file-transfer")) return;
  const pane = activePane();
  if (!pane?.sessionId) {
    setFileTransferOutput(tr("status.pluginFileNoSession"), "error");
    return;
  }
  const targetPath = uploadTargetPath(fileTransferPath(), file.name);
  if (!targetPath) {
    setFileTransferOutput(tr("validation.pluginPath"), "error");
    return;
  }
  setFileTransferOutput("");
  try {
    const done = await actionClient.uploadFile(file, pane.sessionId, targetPath, {
      onProgress: (meta) => setFileTransferOutput(transferProgressText(meta), "neutral"),
    });
    setFileTransferOutput(metaString(done.meta, "content") || transferProgressText(done.meta), "ok");
    setPluginStatus(tr("status.pluginFileUploadDone", { name: file.name }), "ok");
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
  } else if (field === "sendContext") {
    settings.aiSendTerminalContext = value === "true";
  } else if (field === "contextLines") {
    settings.aiContextLines = Math.round(clampNumber(value, 0, 200, DEFAULT_SETTINGS.aiContextLines));
  }
  saveSettings();
  renderPlugins();
}

async function fetchAIModels() {
  if (!pluginIsEnabled("ai-control")) return;
  if (!aiAccessConfigured()) {
    setAIOutput(tr("validation.aiAccess"), "error");
    return;
  }
  setAIOutput(tr("status.aiWorking"));
  try {
    const done = await actionClient.send("ai", "models", {});
    const models = metaStringArray(done.meta, "models");
    aiModelOptions = models;
    if (!settings.aiModel && models[0]) {
      settings.aiModel = models[0];
      saveSettings();
    }
    renderPlugins();
    setAIOutput(models.join("\n") || tr("status.noSessions"), "ok");
    setPluginStatus(tr("status.aiModelsReady", { count: models.length }), "ok");
  } catch (error) {
    setAIOutput(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

async function testAIAccess() {
  if (!pluginIsEnabled("ai-control")) return;
  if (!aiAccessConfigured()) {
    setAIOutput(tr("validation.aiAccess"), "error");
    return;
  }
  setAIOutput(tr("status.aiWorking"));
  try {
    const done = await actionClient.send("ai", "test", {});
    const models = metaStringArray(done.meta, "models");
    if (models.length) {
      aiModelOptions = models;
      if (!settings.aiModel && models[0]) {
        settings.aiModel = models[0];
        saveSettings();
      }
      renderPlugins();
    }
    const message = metaString(done.meta, "message") || tr("status.aiTestOk");
    const content = metaString(done.meta, "content");
    setAIOutput([message, content].filter(Boolean).join("\n"), "ok");
    setPluginStatus(tr("status.aiTestOk"), "ok");
  } catch (error) {
    setAIOutput(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

async function runAIAction(action: string) {
  if (action !== "chat" && action !== "nl2cmd" && action !== "complete" && action !== "explain") return;
  if (!pluginIsEnabled("ai-control")) return;
  if (!aiAccessConfigured()) {
    setAIOutput(tr("validation.aiAccess"), "error");
    return;
  }
  const prompt = aiPromptValue();
  if (!prompt) {
    setAIOutput(tr("validation.aiPrompt"), "error");
    return;
  }
  setAIOutput(tr("status.aiWorking"));
  let output = "";
  try {
    await actionClient.send("ai", action, aiActionPayload(action, prompt), {
      onStream: (chunk) => {
        output += chunk;
        setAIOutput(output, "ok");
      },
    });
    setPluginStatus(tr("status.aiTestOk"), "ok");
  } catch (error) {
    setAIOutput(errorMessage(error), "error");
    setPluginStatus(errorMessage(error), "error");
  }
}

function insertAIOutputIntoTerminal() {
  const output = aiOutputText();
  const command = commandFromAIOutput(output);
  if (!command) {
    setAIOutput(tr("status.aiNoOutput"), "error");
    return;
  }
  if (!sendActivePaneKeyInput(command)) {
    setAIOutput(tr("status.pluginFileNoSession"), "error");
    return;
  }
  setPluginStatus(tr("status.aiInserted"), "ok");
}

async function copyAIOutput() {
  const output = aiOutputText();
  if (!output) {
    setAIOutput(tr("status.aiNoOutput"), "error");
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
  setAIOutput("");
}

function pluginIsEnabled(pluginId: string): boolean {
  return plugins.find((plugin) => plugin.id === pluginId)?.enabled ?? false;
}

function aiAccessConfigured(): boolean {
  return Boolean(settings.aiBaseUrl.trim() && settings.aiApiKey.trim());
}

function aiPromptValue(): string {
  return document.querySelector<HTMLTextAreaElement>("#aiPrompt")?.value.trim() ?? "";
}

function aiOutputText(): string {
  return document.querySelector<HTMLElement>("#aiOutput")?.textContent?.trim() ?? "";
}

function aiActionPayload(action: string, prompt: string): Record<string, unknown> {
  const ctx = terminalAIContext();
  if (action === "complete") return { partial: prompt, ctx };
  if (action === "explain") return { command: prompt, stdout: "", stderr: "", ctx };
  return { input: prompt, ctx };
}

function terminalAIContext(): Record<string, unknown> {
  const pane = activePane();
  const context: Record<string, unknown> = {
    cwd: "~",
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

function setAIOutput(message: string, tone: Tone = "neutral") {
  const output = document.querySelector<HTMLElement>("#aiOutput");
  if (!output) return;
  output.textContent = message;
  output.dataset.tone = tone;
}

function commandFromAIOutput(output: string): string {
  const commandLine = output.match(/(?:命令|Command)\s*[:：]\s*`?([^\n`]+)/i)?.[1]
    ?? output.match(/`([^`\n]+)`/)?.[1]
    ?? output.split("\n").find((line) => line.trim()) ?? "";
  return commandLine.replace(/^\$\s*/, "").trim();
}

function fileTransferPath(): string {
  return document.querySelector<HTMLInputElement>("#fileTransferPath")?.value.trim() ?? "";
}

function uploadTargetPath(path: string, fileName: string): string {
  if (!path) return "";
  if (path === "." || path.endsWith("/")) return `${path}${fileName}`;
  return path;
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
  if (plugin.id === "ai-control") return tr("plugin.aiControl.name");
  if (plugin.id === "file-transfer") return tr("plugin.fileTransfer.name");
  return plugin.displayName || plugin.id;
}

function pluginIcon(pluginId: string): string {
  if (pluginId === "ai-control") return "bot";
  if (pluginId === "file-transfer") return "folder-up";
  return "plug";
}

function pluginDescription(plugin: PluginDescriptor): string {
  if (plugin.id === "ai-control") return tr("plugin.aiControl.description");
  if (plugin.id === "file-transfer") return tr("plugin.fileTransfer.description");
  return plugin.description || plugin.kind || plugin.id;
}

function pluginMetaLabel(value: string): string {
  if (value === "control") return tr("plugin.meta.control");
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
      <button type="button" role="menuitem" data-new-tab-backend="${escapeAttr(id)}">
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
    elements.newTabButton.setAttribute("aria-expanded", "true");
    return;
  }
  closeNewTabMenu();
}

function closeNewTabMenu() {
  elements.newTabMenu.hidden = true;
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
  return `
    <div class="herdr-space" role="option" aria-selected="${workspace.focused}" title="${escapeAttr(details)}">
      <button class="herdr-chip" type="button" data-herdr-workspace="${escapeAttr(workspace.workspace_id)}">
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
    <button class="herdr-tab" type="button" role="tab" data-herdr-tab="${escapeAttr(tab.tab_id)}" aria-selected="${tab.focused}" title="${escapeAttr(tab.tab_id)}">
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
      activatePane(current.tabId, id, { focus: shouldFocusTerminalFromPointer(event) });
    }
  });
  mount.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "touch") return;
    const current = findPaneById(id);
    if (current && runMobileTerminalSwipe(current, event)) {
      event.preventDefault();
      return;
    }
    if (current && isDoubleTerminalTap(current, event)) {
      event.preventDefault();
      focusPaneSystemKeyboard(current);
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
  if (activePane(tab)?.sessionBackend !== "webshell") {
    try {
      await runWorkspaceAction("create_tab", { selector: tab.selector, sessionBackend: "webshell" });
    } catch (error) {
      setGlobalStatus(tr("status.connectFailed", { message: errorMessage(error) }), "error");
    }
    return;
  }
  try {
    await runWorkspaceAction("split_pane", {
      selector: tab.selector,
      tabId: tab.id,
      paneId: activePane(tab)?.id,
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

function schedulePaneViewportReset(pane: TerminalPane) {
  resetPaneViewport(pane);
  window.requestAnimationFrame(() => resetPaneViewport(pane));
}

function resetPaneViewport(pane: TerminalPane) {
  const hosts = [
    pane.mount,
    ...pane.mount.querySelectorAll<HTMLElement>(".restty-pane-root, textarea, [contenteditable='true']"),
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
    const named = Boolean(tab.customTitle?.trim());
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
      void closeTab(button.dataset.closeTab ?? "");
    });
    button.addEventListener("auxclick", (event) => event.stopPropagation());
  });
  elements.tabList.querySelectorAll<HTMLElement>(".tab").forEach((tabElement) => {
    tabElement.addEventListener("auxclick", (event) => {
      if (event.button !== 1) return;
      const tabId = tabElement.querySelector<HTMLElement>("[data-tab-id]")?.dataset.tabId;
      if (tabId) void closeTab(tabId);
    });
  });
  updateIcons();
  focusRenameInput();
}

function updateTabChrome() {
  elements.webshell.classList.toggle("has-named-tabs", tabs.some((tab) => Boolean(tab.customTitle?.trim())));
}

function tabDisplayName(tab: TerminalTab): string {
  return (isHerdrTab(tab) ? herdrWorkspaceLabelForTab(tab) : "")
    || tab.customTitle?.trim()
    || herdrWorkspaceLabelForTab(tab)
    || String(tabs.findIndex((item) => item.id === tab.id) + 1);
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
  if (workspace.label.trim() === nextLabel) return;
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

function cancelTabRename() {
  renamingTabId = undefined;
  renderTabs();
  activePane()?.term?.focus();
}

function closeActiveTab() {
  const tab = activeTab();
  if (!tab) return;
  void closeTab(tab.id);
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
  if (visiblePanes(tab).length <= 1) {
    await closeTab(tab.id);
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
  const close = dx * dx + dy * dy <= 32 * 32;
  const fast = now - lastMobileTerminalTap.time <= 420;
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

function runMobileTerminalSwipe(pane: TerminalPane, event: PointerEvent): boolean {
  if (event.pointerType !== "touch" || mobileTerminalSwipe.paneId !== pane.id) return false;
  const dx = event.clientX - mobileTerminalSwipe.x;
  const dy = event.clientY - mobileTerminalSwipe.y;
  const elapsed = performance.now() - mobileTerminalSwipe.time;
  mobileTerminalSwipe.paneId = "";
  if (elapsed > 700 || Math.abs(dx) < 72 || Math.abs(dx) < Math.abs(dy) * 1.6) {
    return false;
  }
  activateAdjacentTab(dx < 0 ? 1 : -1);
  return true;
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
    pasteTextIntoPane(pane, text);
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
