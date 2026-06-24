export type TabWheelSwitchDirection = -1 | 1;

export type TabWheelSwitchOptions = {
  tabCount: () => number;
  canSwitch: () => boolean;
  switchTab: (direction: TabWheelSwitchDirection) => void;
};

const WHEEL_SWITCH_THRESHOLD_PX = 28;
const WHEEL_SWITCH_COOLDOWN_MS = 180;

export function bindTabWheelSwitch(tabList: HTMLElement, options: TabWheelSwitchOptions) {
  let remainder = 0;
  let lastSwitchAt = 0;

  tabList.addEventListener("wheel", (event) => {
    if (!desktopWheelSwitchEnabled() || options.tabCount() < 2 || !options.canSwitch()) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input, textarea, select, [contenteditable='true']")) return;

    const delta = dominantWheelDeltaPx(event);
    if (!delta) return;
    event.preventDefault();

    const now = performance.now();
    if (now - lastSwitchAt < WHEEL_SWITCH_COOLDOWN_MS) return;
    remainder += delta;
    if (Math.abs(remainder) < WHEEL_SWITCH_THRESHOLD_PX) return;

    options.switchTab(remainder > 0 ? 1 : -1);
    remainder = 0;
    lastSwitchAt = now;
  }, { passive: false });
}

function desktopWheelSwitchEnabled(): boolean {
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

function dominantWheelDeltaPx(event: WheelEvent): number {
  const raw = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
  if (!raw) return 0;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return raw * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return raw * 120;
  return raw;
}
