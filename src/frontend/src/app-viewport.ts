const MOBILE_USER_AGENT_PATTERN = /Android|iPhone|iPad|iPod|Mobile|Harmony|HUAWEI|Miui/i;

export type ViewportMetricsOptions = {
  keyboardInsetThresholdPx: number;
};

export function updateViewportMetrics(options: ViewportMetricsOptions) {
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
  const mobileControls = shouldUseMobileControls(width);
  document.body.classList.toggle("mobile-keyboard-visible", keyboardInset > options.keyboardInsetThresholdPx);
  document.body.classList.toggle("mobile-controls-enabled", mobileControls);
  document.body.classList.toggle("desktop-controls-enabled", !mobileControls && shouldUseDesktopControls(width));
}

export function shouldUseMobileControls(viewportWidth = Math.max(1, window.innerWidth || 0)): boolean {
  const mobileUA = MOBILE_USER_AGENT_PATTERN.test(navigator.userAgent);
  const coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  const screenWidth = Math.max(0, Math.floor(window.screen?.width || 0));
  const screenHeight = Math.max(0, Math.floor(window.screen?.height || 0));
  const compactScreen = screenWidth > 0
    && screenHeight > 0
    && Math.min(screenWidth, screenHeight) <= 820;
  return viewportWidth <= 760
    || compactScreen
    || mobileUA
    || coarsePointer
    || (navigator.maxTouchPoints > 0 && viewportWidth <= 1180);
}

export function shouldUseDesktopControls(viewportWidth = Math.max(1, window.innerWidth || 0)): boolean {
  return viewportWidth > 1180
    && navigator.maxTouchPoints === 0
    && window.matchMedia("(hover: hover) and (pointer: fine)").matches
    && !MOBILE_USER_AGENT_PATTERN.test(navigator.userAgent);
}
