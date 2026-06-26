import type { TerminalPane, TouchSelectionMode } from "./types";

const TOUCH_SCROLL_THRESHOLD_PX = 6;
const FALLBACK_TOUCH_SCROLL_MULTIPLIER = 1.5;
const WHEEL_PIXEL_SCROLL_MULTIPLIER = 2;
const WHEEL_LINE_DELTA_PX = 40;

export type ScrollbackFallbackOptions = {
  touchSelectionMode: () => TouchSelectionMode;
};

export function installPaneScrollbackFallback(
  pane: TerminalPane,
  options: ScrollbackFallbackOptions,
) {
  pane.mount.classList.toggle("herdr-scrollback-fallback", paneIsHerdr(pane));
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
    const handled = paneIsHerdr(pane)
      ? scrollHerdrPaneFromWheel(pane, event)
      : scrollNonHerdrPaneFromWheel(pane, event);
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointerdown", (event) => {
    if (paneMouseReportingActive(pane, event) && !paneTouchBypassesMouseReporting(pane, event)) return;
    if (event.pointerType !== "touch" || !paneTouchScrollbackFallbackEnabled(pane, options)) return;
    const host = paneScrollbackHost(pane);
    if (!paneHasScrollableFallback(pane, host)) return;
    touchPointerId = event.pointerId;
    lastTouchY = event.clientY;
    touchScrollActive = false;
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointermove", (event) => {
    if (paneMouseReportingActive(pane, event) && !paneTouchBypassesMouseReporting(pane, event)) return;
    if (touchPointerId !== event.pointerId || !paneTouchScrollbackFallbackEnabled(pane, options)) return;
    const host = paneScrollbackHost(pane);
    const deltaPx = lastTouchY - event.clientY;
    if (!paneHasScrollableFallback(pane, host)) return;
    if (!touchScrollActive && Math.abs(deltaPx) < TOUCH_SCROLL_THRESHOLD_PX) return;
    touchScrollActive = true;
    lastTouchY = event.clientY;
    if (scrollPaneByPixels(pane, host, deltaPx)) {
      event.preventDefault();
      event.stopPropagation();
    }
  }, { capture: true, passive: false });

  pane.mount.addEventListener("pointerup", (event) => stopTouchScroll(event.pointerId), true);
  pane.mount.addEventListener("pointercancel", (event) => stopTouchScroll(event.pointerId), true);
  pane.mount.addEventListener("lostpointercapture", (event) => stopTouchScroll(event.pointerId), true);
  pane.scrollbackFallbackInstalled = true;
}

function scrollNonHerdrPaneFromWheel(pane: TerminalPane, event: WheelEvent): boolean {
  if (paneMouseReportingActive(pane, event)) return false;
  const host = paneScrollbackHost(pane);
  if (!host || !hostCanScroll(host)) return false;
  return scrollPaneHost(host, normalizedWheelDeltaPx(event, host));
}

function scrollHerdrPaneFromWheel(pane: TerminalPane, event: WheelEvent): boolean {
  const host = paneScrollbackHost(pane);
  const deltaPx = normalizedWheelDeltaPx(event, host ?? pane.mount);
  if (host && hostCanScroll(host) && scrollPaneHost(host, deltaPx)) return true;
  return scrollResttyViewportByWheel(pane, event);
}

function scrollPaneByPixels(pane: TerminalPane, host: HTMLElement | null, deltaPx: number): boolean {
  if (host && hostCanScroll(host) && scrollPaneHost(host, deltaPx)) return true;
  if (!paneIsHerdr(pane)) return false;
  return scrollResttyViewportByPixels(pane, deltaPx);
}

function scrollResttyViewportByPixels(pane: TerminalPane, deltaPx: number): boolean {
  if (!Number.isFinite(deltaPx) || Math.abs(deltaPx) < 1) return false;
  const term = pane.term;
  if (!term?.restty) return false;
  const lines = resttyScrollLinesFromPixels(pane.mount, deltaPx);
  if (!Number.isFinite(lines) || Math.abs(lines) < 0.25) return false;
  term.scrollViewportByLines(lines);
  return true;
}

function scrollResttyViewportByWheel(pane: TerminalPane, event: WheelEvent): boolean {
  const term = pane.term;
  if (!term?.restty) return false;
  let lines = 0;
  if (event.deltaMode === 1) {
    const yoff = event.deltaY > 0 ? Math.max(event.deltaY, 1) : Math.min(event.deltaY, -1);
    lines = yoff * 3;
  } else if (event.deltaMode === 2) {
    const pageLines = pane.term?.rows ?? pane.rows ?? 24;
    lines = event.deltaY * Math.max(1, pageLines);
  } else {
    lines = event.deltaY / terminalLineHeightPx(pane.mount) * WHEEL_PIXEL_SCROLL_MULTIPLIER;
  }
  if (!Number.isFinite(lines) || Math.abs(lines) < 0.25) return false;
  term.scrollViewportByLines(lines);
  return true;
}

function resttyScrollLinesFromPixels(mount: HTMLElement, deltaPx: number): number {
  return deltaPx / terminalLineHeightPx(mount) * FALLBACK_TOUCH_SCROLL_MULTIPLIER;
}

function terminalLineHeightPx(mount: HTMLElement): number {
  const style = getComputedStyle(mount);
  const fontSize = positiveCssNumber(style.getPropertyValue("--term-font-size"))
    ?? positiveCssNumber(style.fontSize)
    ?? 14;
  const lineHeightValue = style.getPropertyValue("--term-line-height").trim() || style.lineHeight.trim();
  const lineHeight = positiveCssNumber(lineHeightValue);
  if (!lineHeight) return fontSize * 1.35;
  if (lineHeightValue.endsWith("px")) return lineHeight;
  if (lineHeightValue === "normal") return fontSize * 1.35;
  return lineHeight * fontSize;
}

function positiveCssNumber(value: string): number | undefined {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function paneScrollbackHost(pane: TerminalPane): HTMLElement | null {
  return pane.mount.querySelector<HTMLElement>(".restty-native-scroll-host");
}

function paneHasScrollableFallback(pane: TerminalPane, host: HTMLElement | null): boolean {
  return Boolean(host && hostCanScroll(host)) || (paneIsHerdr(pane) && Boolean(pane.term?.restty));
}

function paneTouchScrollbackFallbackEnabled(
  pane: TerminalPane,
  options: ScrollbackFallbackOptions,
): boolean {
  return pane.sessionBackend === "herdr" || options.touchSelectionMode() !== "drag";
}

function paneTouchBypassesMouseReporting(pane: TerminalPane, event: MouseEvent | PointerEvent): boolean {
  return paneIsHerdr(pane) && "pointerType" in event && event.pointerType === "touch";
}

function paneMouseReportingActive(pane: TerminalPane, event: MouseEvent | PointerEvent): boolean {
  if (event.shiftKey) return false;
  return Boolean(pane.term?.restty?.getMouseStatus().active);
}

function hostCanScroll(host: HTMLElement): boolean {
  return host.scrollHeight > host.clientHeight + 1;
}

function normalizedWheelDeltaPx(event: WheelEvent, host: HTMLElement): number {
  if (event.deltaMode === 1) return event.deltaY * WHEEL_LINE_DELTA_PX;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, host.clientHeight);
  return event.deltaY;
}

function scrollPaneHost(host: HTMLElement, deltaPx: number): boolean {
  if (!Number.isFinite(deltaPx) || !deltaPx) return false;
  const before = host.scrollTop;
  host.scrollTop += deltaPx;
  return Math.abs(host.scrollTop - before) > 0.5;
}

function paneIsHerdr(pane: TerminalPane): boolean {
  return pane.sessionBackend === "herdr";
}
