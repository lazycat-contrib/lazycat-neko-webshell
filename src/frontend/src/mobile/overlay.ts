import { shouldUseMobileControls } from "../app-viewport";

export function isMobileOverlayMode(): boolean {
  const viewportWidth = Math.max(1, Math.floor(window.visualViewport?.width ?? (window.innerWidth || 0)));
  return shouldUseMobileControls(viewportWidth);
}

export function blurActiveElement() {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur();
  }
}

export function prepareMobileOverlay(onPrepare: () => void) {
  if (isMobileOverlayMode()) {
    onPrepare();
    blurActiveElement();
  }
}
