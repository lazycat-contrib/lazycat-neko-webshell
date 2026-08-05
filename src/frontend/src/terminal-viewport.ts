import type { TerminalPane } from "./types";
import { installTouchKeyboardReadOnlyGuard } from "./mobile/touch-keyboard-guard";
import type { MobileTerminalGesture } from "./mobile/terminal-gestures";
import { paneTerminalImeInput } from "./terminal-dom";

export type PaneViewportGuardOptions = {
  scheduleSizeRefresh: () => void;
};

export type PaneTouchKeyboardGuardOptions = {
  onGestureEnd?: (event: Event, gesture: MobileTerminalGesture, cancelled: boolean) => void;
  scrollLockThresholdPx: number;
  scrollAxisRatio: number;
};

export function installPaneViewportGuard(
  pane: TerminalPane,
  options: PaneViewportGuardOptions,
) {
  if (pane.viewportGuardInstalled) return;
  const resetAndResize = () => {
    schedulePaneViewportReset(pane);
    options.scheduleSizeRefresh();
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

export function installPaneTouchKeyboardGuard(
  pane: TerminalPane,
  options: PaneTouchKeyboardGuardOptions,
) {
  if (pane.touchKeyboardGuardInstalled) return;
  pane.touchKeyboardGuardDispose = installTouchKeyboardReadOnlyGuard({
    pane: pane.mount,
    globalTarget: window,
    visibilityTarget: document,
    input: () => paneImeInput(pane),
    onGestureEnd: options.onGestureEnd,
    scrollLockThresholdPx: options.scrollLockThresholdPx,
    scrollAxisRatio: options.scrollAxisRatio,
  });
  pane.touchKeyboardGuardInstalled = true;
}

export function schedulePaneViewportReset(pane: TerminalPane) {
  resetPaneViewport(pane);
  window.requestAnimationFrame(() => resetPaneViewport(pane));
}

export function resetPaneViewport(pane: TerminalPane) {
  const hosts = [
    ...pane.mount.querySelectorAll<HTMLElement>("textarea, [contenteditable='true']"),
  ];
  for (const host of hosts) {
    if (host.scrollTop !== 0) host.scrollTop = 0;
    if (host.scrollLeft !== 0) host.scrollLeft = 0;
  }
}

export function paneImeInput(pane: TerminalPane): HTMLTextAreaElement | null {
  return paneTerminalImeInput(pane);
}
