import type { TerminalPane } from "../types.ts";

export type MobileSystemKeyboardControllerOptions = {
  activePane: () => TerminalPane | undefined;
  dismissPane: (pane: TerminalPane) => void;
  enableAllPanes: () => void;
  focusAutomaticPane?: (pane: TerminalPane) => boolean;
  focusHardwarePane: (pane: TerminalPane) => void;
  focusPane: (pane: TerminalPane) => boolean;
  isPaneKeyboardFocused?: (pane: TerminalPane) => boolean;
  preventAutoOpen?: () => boolean;
  updateToggle: (enabled: boolean) => void;
};

export function createMobileSystemKeyboardController(
  options: MobileSystemKeyboardControllerOptions,
) {
  let enabled = false;
  let keyboardPane: TerminalPane | undefined;
  let viewportKeyboardVisible = false;
  let viewportDismissPending = false;
  let mobileControlsEnabled = true;
  let shortcutRevision = 0;
  const preventsAutoOpen = () => options.preventAutoOpen?.() ?? true;
  const invalidateShortcuts = () => {
    shortcutRevision += 1;
  };

  const dismiss = (pane: TerminalPane) => {
    options.dismissPane(pane);
    options.focusHardwarePane(pane);
  };

  const paneKeyboardOpen = (pane: TerminalPane) => Boolean(
    (enabled && keyboardPane === pane && (options.isPaneKeyboardFocused?.(pane) ?? true))
    || (!preventsAutoOpen() && !viewportDismissPending && (
      (viewportKeyboardVisible && pane === options.activePane())
      || options.isPaneKeyboardFocused?.(pane)
    )),
  );

  const preservePaneState = (pane: TerminalPane) => {
    invalidateShortcuts();
    if (!mobileControlsEnabled || paneKeyboardOpen(pane)) return;
    dismiss(pane);
  };

  const preserveState = () => {
    const revision = ++shortcutRevision;
    if (!mobileControlsEnabled) return () => {};
    const pane = options.activePane();
    const keyboardOpen = Boolean(pane && paneKeyboardOpen(pane));
    const keyboardExplicit = keyboardOpen && enabled;
    const keyboardVisible = viewportKeyboardVisible;
    if (pane && !keyboardOpen) dismiss(pane);
    let restored = false;
    return () => {
      if (restored || revision !== shortcutRevision || !mobileControlsEnabled) return;
      restored = true;
      const active = options.activePane();
      if (!active) {
        enabled = false;
        keyboardPane = undefined;
        viewportKeyboardVisible = false;
        viewportDismissPending = false;
        options.updateToggle(false);
        return;
      }
      if (!keyboardOpen) {
        enabled = false;
        keyboardPane = undefined;
        viewportDismissPending = viewportKeyboardVisible;
        dismiss(active);
        options.updateToggle(false);
        return;
      }
      if (keyboardExplicit && !keyboardVisible && pane && active !== pane) {
        enabled = false;
        keyboardPane = undefined;
        viewportKeyboardVisible = false;
        viewportDismissPending = false;
        dismiss(active);
        options.updateToggle(false);
        return;
      }
      if (keyboardExplicit) {
        enabled = options.isPaneKeyboardFocused?.(active) || options.focusPane(active);
        keyboardPane = enabled ? active : undefined;
        options.updateToggle(enabled);
        return;
      }
      enabled = false;
      const focusAutomaticPane = options.focusAutomaticPane ?? options.focusPane;
      const focused = options.isPaneKeyboardFocused?.(active) || focusAutomaticPane(active);
      keyboardPane = focused ? active : undefined;
      options.updateToggle(false);
    };
  };

  const restoreState = () => {
    invalidateShortcuts();
    if (!mobileControlsEnabled) return;
    const pane = options.activePane();
    if (!preventsAutoOpen()) {
      const previousKeyboardPane = keyboardPane;
      enabled = false;
      keyboardPane = undefined;
      if (previousKeyboardPane && previousKeyboardPane !== pane) {
        options.dismissPane(previousKeyboardPane);
      }
      const focusAutomaticPane = options.focusAutomaticPane ?? options.focusPane;
      if (
        pane
        && (options.isPaneKeyboardFocused?.(pane) || focusAutomaticPane(pane))
      ) {
        keyboardPane = pane;
      }
      options.updateToggle(false);
      return;
    }
    if (!pane) {
      const previousKeyboardPane = keyboardPane;
      enabled = false;
      keyboardPane = undefined;
      if (previousKeyboardPane) {
        viewportDismissPending = viewportKeyboardVisible;
        options.dismissPane(previousKeyboardPane);
      }
      options.updateToggle(false);
      return;
    }
    if (enabled && pane !== keyboardPane) {
      const previousKeyboardPane = keyboardPane;
      enabled = false;
      keyboardPane = undefined;
      if (previousKeyboardPane) {
        viewportDismissPending = viewportKeyboardVisible;
        options.dismissPane(previousKeyboardPane);
      }
    }
    if (!enabled) {
      viewportDismissPending = viewportKeyboardVisible;
      dismiss(pane);
    }
    options.updateToggle(enabled);
  };

  const showPane = (pane = options.activePane()) => {
    if (!mobileControlsEnabled) return;
    if (!pane) return;
    if (viewportKeyboardVisible && !enabled) {
      options.updateToggle(false);
      return;
    }
    viewportDismissPending = false;
    enabled = options.focusPane(pane);
    keyboardPane = enabled ? pane : undefined;
    options.updateToggle(enabled);
  };

  const show = (pane = options.activePane()) => {
    invalidateShortcuts();
    showPane(pane);
  };

  const toggle = () => {
    invalidateShortcuts();
    if (!mobileControlsEnabled) return;
    const pane = options.activePane();
    if (!pane) return;
    if (enabled || viewportKeyboardVisible || options.isPaneKeyboardFocused?.(pane)) {
      enabled = false;
      keyboardPane = undefined;
      viewportDismissPending = viewportKeyboardVisible;
      dismiss(pane);
      options.updateToggle(false);
      return;
    }
    showPane(pane);
  };

  const dismissAfterGesture = (pane: TerminalPane) => {
    invalidateShortcuts();
    if (!mobileControlsEnabled) return;
    const previousKeyboardPane = keyboardPane;
    enabled = false;
    keyboardPane = undefined;
    viewportDismissPending = viewportKeyboardVisible;
    if (previousKeyboardPane && previousKeyboardPane !== pane) {
      options.dismissPane(previousKeyboardPane);
    }
    dismiss(pane);
    options.updateToggle(false);
  };

  const dismissForOverlay = (pane = options.activePane()) => {
    invalidateShortcuts();
    if (!mobileControlsEnabled) return;
    const previousKeyboardPane = keyboardPane;
    enabled = false;
    keyboardPane = undefined;
    viewportDismissPending = viewportKeyboardVisible;
    if (previousKeyboardPane && previousKeyboardPane !== pane) {
      options.dismissPane(previousKeyboardPane);
    }
    if (pane) options.dismissPane(pane);
    options.updateToggle(false);
  };

  const resetMountedPane = (pane: TerminalPane) => {
    if (!mobileControlsEnabled || !preventsAutoOpen() || pane !== options.activePane()) return false;
    invalidateShortcuts();
    const previousKeyboardPane = keyboardPane;
    enabled = false;
    keyboardPane = undefined;
    viewportDismissPending = viewportKeyboardVisible;
    if (previousKeyboardPane && previousKeyboardPane !== pane) {
      options.dismissPane(previousKeyboardPane);
    }
    dismiss(pane);
    options.updateToggle(false);
    return true;
  };

  const sync = (visible: boolean, controlsEnabled = true) => {
    invalidateShortcuts();
    if (!controlsEnabled) {
      mobileControlsEnabled = false;
      enabled = false;
      keyboardPane = undefined;
      viewportKeyboardVisible = false;
      viewportDismissPending = false;
      options.enableAllPanes();
      options.updateToggle(false);
      return;
    }
    if (!mobileControlsEnabled) {
      mobileControlsEnabled = true;
      enabled = false;
      keyboardPane = undefined;
      viewportKeyboardVisible = false;
      viewportDismissPending = false;
      if (!preventsAutoOpen()) {
        options.enableAllPanes();
      } else {
        const pane = options.activePane();
        if (pane) dismiss(pane);
      }
    }
    if (!preventsAutoOpen()) {
      if (visible) {
        viewportKeyboardVisible = true;
        if (enabled) viewportDismissPending = false;
        keyboardPane = options.activePane();
      } else if (viewportKeyboardVisible) {
        viewportKeyboardVisible = false;
        viewportDismissPending = false;
        enabled = false;
        keyboardPane = undefined;
      }
      options.updateToggle(enabled);
      return;
    }
    if (visible && enabled) {
      viewportKeyboardVisible = true;
      viewportDismissPending = false;
      keyboardPane = options.activePane();
    } else if (!visible && viewportKeyboardVisible) {
      viewportKeyboardVisible = false;
      viewportDismissPending = false;
      if (enabled) {
        enabled = false;
        keyboardPane = undefined;
        const pane = options.activePane();
        if (pane) dismiss(pane);
      }
    }
    options.updateToggle(enabled);
  };

  const applyPreference = () => {
    invalidateShortcuts();
    enabled = false;
    keyboardPane = undefined;
    if (!mobileControlsEnabled || !preventsAutoOpen()) {
      viewportKeyboardVisible = false;
      viewportDismissPending = false;
      options.enableAllPanes();
      options.updateToggle(false);
      return;
    }
    viewportDismissPending = viewportKeyboardVisible;
    const pane = options.activePane();
    if (pane) dismiss(pane);
    options.updateToggle(false);
  };

  return {
    applyPreference,
    dismissAfterGesture,
    dismissForOverlay,
    preservePaneState,
    preserveState,
    resetMountedPane,
    restoreState,
    show,
    toggle,
    sync,
  };
}
