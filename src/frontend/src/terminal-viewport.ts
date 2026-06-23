import type { TerminalPane } from "./types";

export type PaneViewportGuardOptions = {
  scheduleSizeRefresh: () => void;
};

export type PaneTouchKeyboardGuardOptions = {
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
    if (Math.hypot(dx, dy) < options.scrollLockThresholdPx) return;
    if (absDy < absDx * options.scrollAxisRatio) return;
    scrollLocked = true;
  }, { capture: true, passive: true });

  pane.mount.addEventListener("pointerup", (event) => stopTouch(event.pointerId), true);
  pane.mount.addEventListener("pointercancel", (event) => stopTouch(event.pointerId), true);
  pane.mount.addEventListener("lostpointercapture", (event) => stopTouch(event.pointerId), true);
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
  return pane.term?.restty?.activePane()?.getRawPane().imeInput ?? null;
}
