import type { TerminalPane } from "../types.ts";

export type MobileSystemKeyboardControllerOptions = {
  activePane: () => TerminalPane | undefined;
  dismissPane: (pane: TerminalPane) => void;
  enableAllPanes: () => void;
  focusHardwarePane: (pane: TerminalPane) => void;
  focusPane: (pane: TerminalPane) => boolean;
  updateToggle: (enabled: boolean) => void;
};

export function createMobileSystemKeyboardController(
  options: MobileSystemKeyboardControllerOptions,
) {
  let enabled = false;
  let keyboardPane: TerminalPane | undefined;
  let viewportKeyboardVisible = false;
  let mobileControlsEnabled = true;

  const dismiss = (pane: TerminalPane) => {
    options.dismissPane(pane);
    options.focusHardwarePane(pane);
  };

  const preserveState = () => {
    if (!mobileControlsEnabled) return;
    const pane = options.activePane();
    if (!enabled && pane) dismiss(pane);
  };

  const restoreState = () => {
    if (!mobileControlsEnabled) return;
    const pane = options.activePane();
    if (!pane) {
      const previousKeyboardPane = keyboardPane;
      enabled = false;
      keyboardPane = undefined;
      if (previousKeyboardPane) options.dismissPane(previousKeyboardPane);
      options.updateToggle(false);
      return;
    }
    if (enabled && pane !== keyboardPane) {
      const previousKeyboardPane = keyboardPane;
      enabled = false;
      keyboardPane = undefined;
      if (previousKeyboardPane) {
        options.dismissPane(previousKeyboardPane);
      }
    }
    if (!enabled) dismiss(pane);
    options.updateToggle(enabled);
  };

  const show = (pane = options.activePane()) => {
    if (!mobileControlsEnabled) return;
    if (!pane) return;
    if (viewportKeyboardVisible && !enabled) {
      options.updateToggle(false);
      return;
    }
    enabled = options.focusPane(pane);
    keyboardPane = enabled ? pane : undefined;
    options.updateToggle(enabled);
  };

  const toggle = () => {
    if (!mobileControlsEnabled) return;
    const pane = options.activePane();
    if (!pane) return;
    if (enabled) {
      enabled = false;
      keyboardPane = undefined;
      dismiss(pane);
      options.updateToggle(false);
      return;
    }
    show(pane);
  };

  const resetMountedPane = (pane: TerminalPane) => {
    if (!mobileControlsEnabled || pane !== options.activePane()) return false;
    const previousKeyboardPane = keyboardPane;
    enabled = false;
    keyboardPane = undefined;
    if (previousKeyboardPane && previousKeyboardPane !== pane) {
      options.dismissPane(previousKeyboardPane);
    }
    dismiss(pane);
    options.updateToggle(false);
    return true;
  };

  const sync = (visible: boolean, controlsEnabled = true) => {
    if (!controlsEnabled) {
      mobileControlsEnabled = false;
      enabled = false;
      keyboardPane = undefined;
      viewportKeyboardVisible = false;
      options.enableAllPanes();
      options.updateToggle(false);
      return;
    }
    if (!mobileControlsEnabled) {
      mobileControlsEnabled = true;
      enabled = false;
      keyboardPane = undefined;
      viewportKeyboardVisible = false;
      const pane = options.activePane();
      if (pane) dismiss(pane);
    }
    if (visible && enabled) {
      viewportKeyboardVisible = true;
      keyboardPane = options.activePane();
    } else if (viewportKeyboardVisible) {
      viewportKeyboardVisible = false;
      if (enabled) {
        enabled = false;
        keyboardPane = undefined;
        const pane = options.activePane();
        if (pane) dismiss(pane);
      }
    }
    options.updateToggle(enabled);
  };

  return { preserveState, resetMountedPane, restoreState, show, toggle, sync };
}
