import type { ShellElements } from "./shell";
import { isMobileOverlayMode } from "./mobile/overlay";

type AppOverlayElements = Pick<
  ShellElements,
  | "aboutClose"
  | "aboutDialog"
  | "closeSettings"
  | "instanceButton"
  | "instanceMenu"
  | "instanceSwitcher"
  | "pluginSidebar"
  | "pluginsButton"
  | "settingsButton"
  | "settingsMenu"
  | "settingsPage"
  | "shortcutHelp"
  | "shortcutHelpButton"
  | "shortcutHelpClose"
  | "terminalStage"
  | "topbar"
  | "webshell"
>;

type CloseOptions = { restoreFocus?: boolean };

export type AppOverlaysController = {
  openSettings: (tabId?: string) => void;
  closeSettings: (options?: CloseOptions) => void;
  toggleSettingsMenu: () => void;
  closeSettingsMenu: () => void;
  togglePluginSidebar: () => void;
  openPluginSidebar: () => void;
  closePluginSidebar: (options?: CloseOptions) => void;
  toggleShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  openAboutDialog: () => void;
  closeAboutDialog: () => void;
  toggleFullscreen: () => Promise<void>;
  closeMobileOverlaysBeforeViewportChange: () => void;
  restoreTerminalFocusAfterOverlay: () => void;
  toggleInstanceMenu: () => void;
  closeInstanceMenu: () => void;
};

export function createAppOverlaysController(options: {
  elements: AppOverlayElements;
  activateSettingsTab: (tabId: string) => void;
  pluginsLoaded: () => boolean;
  pluginsLoading: () => boolean;
  loadPlugins: () => void;
  renderPluginTools: () => void;
  closePaneMenu: () => void;
  closeNewTabMenu: () => void;
  closeHerdrWorkspaceMenu: () => void;
  closeNotificationsMenu: () => void;
  closeNotificationModal: () => void;
  focusActivePaneCanvas: () => void;
  handleViewportChange: () => void;
  prepareMobileOverlay: () => void;
}): AppOverlaysController {
  const { elements } = options;

  function setAppBackgroundInert(inert: boolean) {
    for (const element of [elements.topbar, elements.terminalStage]) {
      if ("inert" in element) {
        element.inert = inert;
      }
      element.setAttribute("aria-hidden", String(inert));
    }
  }

  function restoreTerminalFocusAfterOverlay() {
    if (!isMobileOverlayMode()) {
      options.focusActivePaneCanvas();
    }
  }

  function closeSettings(closeOptions: CloseOptions = {}) {
    elements.settingsPage.hidden = true;
    elements.webshell.classList.remove("settings-open");
    setAppBackgroundInert(false);
    if (closeOptions.restoreFocus !== false) {
      restoreTerminalFocusAfterOverlay();
    }
  }

  function closeSettingsMenu() {
    elements.settingsMenu.hidden = true;
    elements.settingsButton.setAttribute("aria-expanded", "false");
  }

  function closeInstanceMenu() {
    elements.instanceMenu.hidden = true;
    elements.instanceSwitcher.classList.remove("is-open");
    elements.instanceButton.setAttribute("aria-expanded", "false");
  }

  function closeShortcutHelp() {
    elements.shortcutHelp.hidden = true;
    elements.shortcutHelpButton.setAttribute("aria-expanded", "false");
  }

  function closeAboutDialog() {
    elements.aboutDialog.hidden = true;
  }

  function closePluginSidebar(closeOptions: CloseOptions = {}) {
    elements.pluginSidebar.hidden = true;
    elements.webshell.classList.remove("plugins-open");
    elements.pluginsButton.setAttribute("aria-expanded", "false");
    if (closeOptions.restoreFocus !== false) {
      restoreTerminalFocusAfterOverlay();
    }
  }

  function openSettings(tabId?: string) {
    options.prepareMobileOverlay();
    elements.settingsPage.hidden = false;
    elements.webshell.classList.add("settings-open");
    setAppBackgroundInert(true);
    closeInstanceMenu();
    closeSettingsMenu();
    if (tabId) {
      options.activateSettingsTab(tabId);
    }
    if (!options.pluginsLoaded() && !options.pluginsLoading()) {
      options.loadPlugins();
    }
    requestAnimationFrame(() => elements.closeSettings.focus());
  }

  function toggleSettingsMenu() {
    const open = elements.settingsMenu.hidden;
    if (open) {
      options.prepareMobileOverlay();
    }
    closeShortcutHelp();
    elements.settingsMenu.hidden = !open;
    elements.settingsButton.setAttribute("aria-expanded", String(open));
  }

  function openPluginSidebar() {
    options.prepareMobileOverlay();
    closeSettingsMenu();
    closeShortcutHelp();
    closeInstanceMenu();
    options.closePaneMenu();
    if (!elements.settingsPage.hidden) {
      closeSettings({ restoreFocus: false });
    }
    elements.pluginSidebar.hidden = false;
    elements.webshell.classList.add("plugins-open");
    elements.pluginsButton.setAttribute("aria-expanded", "true");
    if (!options.pluginsLoaded() && !options.pluginsLoading()) {
      options.loadPlugins();
    } else {
      options.renderPluginTools();
    }
  }

  function togglePluginSidebar() {
    if (elements.pluginSidebar.hidden) {
      openPluginSidebar();
    } else {
      closePluginSidebar();
    }
  }

  function toggleShortcutHelp() {
    const open = elements.shortcutHelp.hidden;
    if (open) {
      options.prepareMobileOverlay();
    }
    closeSettingsMenu();
    closeInstanceMenu();
    options.closePaneMenu();
    closeAboutDialog();
    elements.shortcutHelp.hidden = !open;
    elements.shortcutHelpButton.setAttribute("aria-expanded", String(open));
    if (open) {
      requestAnimationFrame(() => elements.shortcutHelpClose.focus());
    }
  }

  function openAboutDialog() {
    options.prepareMobileOverlay();
    closeShortcutHelp();
    closeInstanceMenu();
    options.closePaneMenu();
    elements.aboutDialog.hidden = false;
    requestAnimationFrame(() => elements.aboutClose.focus());
  }

  function closeMobileOverlaysBeforeViewportChange() {
    options.prepareMobileOverlay();
    closeSettingsMenu();
    closeInstanceMenu();
    options.closeNewTabMenu();
    options.closeHerdrWorkspaceMenu();
    options.closeNotificationsMenu();
    options.closePaneMenu();
    closeShortcutHelp();
    closeAboutDialog();
    options.closeNotificationModal();
    if (!elements.settingsPage.hidden) {
      closeSettings({ restoreFocus: false });
    }
    if (!elements.pluginSidebar.hidden) {
      closePluginSidebar({ restoreFocus: false });
    }
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
        options.focusActivePaneCanvas();
      }
    } finally {
      options.handleViewportChange();
    }
  }

  function toggleInstanceMenu() {
    const open = elements.instanceMenu.hidden;
    if (open) {
      options.prepareMobileOverlay();
    }
    closeSettingsMenu();
    elements.instanceMenu.hidden = !open;
    elements.instanceSwitcher.classList.toggle("is-open", open);
    elements.instanceButton.setAttribute("aria-expanded", String(open));
  }

  return {
    openSettings,
    closeSettings,
    toggleSettingsMenu,
    closeSettingsMenu,
    togglePluginSidebar,
    openPluginSidebar,
    closePluginSidebar,
    toggleShortcutHelp,
    closeShortcutHelp,
    openAboutDialog,
    closeAboutDialog,
    toggleFullscreen,
    closeMobileOverlaysBeforeViewportChange,
    restoreTerminalFocusAfterOverlay,
    toggleInstanceMenu,
    closeInstanceMenu,
  };
}
