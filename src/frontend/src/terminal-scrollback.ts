import type { TerminalPane, TouchSelectionMode } from "./types";

const TOUCH_SCROLL_THRESHOLD_PX = 6;
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
  let touchWheelRemainderPx = 0;

  const stopTouchScroll = (pointerId: number) => {
    if (touchPointerId !== pointerId) return;
    touchPointerId = undefined;
    touchScrollActive = false;
    touchWheelRemainderPx = 0;
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
    touchWheelRemainderPx = 0;
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
    const handled = paneMouseReportingActive(pane, event)
      ? dispatchHerdrTouchWheel(pane, event, deltaPx, (remainder) => {
        touchWheelRemainderPx = remainder;
      }, touchWheelRemainderPx)
      : scrollPaneByPixels(pane, host, deltaPx);
    if (handled) {
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
  if (paneMouseReportingActive(pane, event)) {
    return rerouteHerdrWheelToCanvas(pane, event);
  }
  const host = paneScrollbackHost(pane);
  const deltaPx = normalizedWheelDeltaPx(event, host ?? pane.mount);
  return Boolean(host && hostCanScroll(host) && scrollPaneHost(host, deltaPx));
}

function scrollPaneByPixels(pane: TerminalPane, host: HTMLElement | null, deltaPx: number): boolean {
  if (host && hostCanScroll(host) && scrollPaneHost(host, deltaPx)) return true;
  return false;
}

function rerouteHerdrWheelToCanvas(pane: TerminalPane, event: WheelEvent): boolean {
  const canvas = paneCanvas(pane);
  if (!canvas || eventTargetIsInside(event.target, canvas)) return false;
  canvas.dispatchEvent(cloneWheelEvent(event));
  return true;
}

function dispatchHerdrTouchWheel(
  pane: TerminalPane,
  sourceEvent: PointerEvent,
  deltaPx: number,
  setRemainder: (value: number) => void,
  currentRemainder: number,
): boolean {
  if (!paneIsHerdr(pane) || !Number.isFinite(deltaPx) || !deltaPx) return false;
  const canvas = paneCanvas(pane);
  if (!canvas) return false;
  const thresholdPx = Math.max(1, terminalLineHeightPx(pane.mount));
  const next = currentRemainder + deltaPx;
  const notches = Math.trunc(next / thresholdPx);
  setRemainder(next - notches * thresholdPx);
  if (!notches) return true;
  const direction = notches > 0 ? 1 : -1;
  const count = Math.min(4, Math.abs(notches));
  for (let index = 0; index < count; index += 1) {
    canvas.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      clientX: sourceEvent.clientX,
      clientY: sourceEvent.clientY,
      ctrlKey: sourceEvent.ctrlKey,
      altKey: sourceEvent.altKey,
      shiftKey: sourceEvent.shiftKey,
      metaKey: sourceEvent.metaKey,
      deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      deltaY: direction * thresholdPx,
    }));
  }
  return true;
}

function cloneWheelEvent(event: WheelEvent): WheelEvent {
  return new WheelEvent("wheel", {
    bubbles: true,
    cancelable: true,
    clientX: event.clientX,
    clientY: event.clientY,
    screenX: event.screenX,
    screenY: event.screenY,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    button: event.button,
    buttons: event.buttons,
    deltaMode: event.deltaMode,
    deltaX: event.deltaX,
    deltaY: event.deltaY,
    deltaZ: event.deltaZ,
  });
}

function paneCanvas(pane: TerminalPane): HTMLElement | null {
  return pane.mount.querySelector<HTMLElement>(".pane-canvas");
}

function eventTargetIsInside(target: EventTarget | null, element: HTMLElement): boolean {
  return target instanceof Node && element.contains(target);
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
