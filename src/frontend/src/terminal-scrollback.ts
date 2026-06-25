import type { TerminalPane, TouchSelectionMode } from "./types";

export type ScrollbackFallbackOptions = {
  touchSelectionMode: () => TouchSelectionMode;
};

export function installPaneScrollbackFallback(
  pane: TerminalPane,
  options: ScrollbackFallbackOptions,
) {
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
    if (paneMouseReportingActive(pane, event)) return;
    const host = paneScrollbackHost(pane);
    if (!host || !hostCanScroll(host)) return;
    if (scrollPaneHost(host, normalizedWheelDeltaPx(event, host))) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointerdown", (event) => {
    if (paneMouseReportingActive(pane, event) && !paneTouchBypassesMouseReporting(pane, event)) return;
    if (event.pointerType !== "touch" || !paneTouchScrollbackFallbackEnabled(pane, options)) return;
    const host = paneScrollbackHost(pane);
    if (!host || !hostCanScroll(host)) return;
    touchPointerId = event.pointerId;
    lastTouchY = event.clientY;
    touchScrollActive = false;
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointermove", (event) => {
    if (paneMouseReportingActive(pane, event) && !paneTouchBypassesMouseReporting(pane, event)) return;
    if (touchPointerId !== event.pointerId || !paneTouchScrollbackFallbackEnabled(pane, options)) return;
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

function paneScrollbackHost(pane: TerminalPane): HTMLElement | null {
  return pane.mount.querySelector<HTMLElement>(".restty-native-scroll-host");
}

function paneTouchScrollbackFallbackEnabled(
  pane: TerminalPane,
  options: ScrollbackFallbackOptions,
): boolean {
  return pane.sessionBackend === "herdr" || options.touchSelectionMode() !== "drag";
}

function paneTouchBypassesMouseReporting(pane: TerminalPane, event: MouseEvent | PointerEvent): boolean {
  return pane.sessionBackend === "herdr" && "pointerType" in event && event.pointerType === "touch";
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
