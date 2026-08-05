const MOBILE_TERMINAL_TAP_MOVE_THRESHOLD_PX = 18;
const MOBILE_TERMINAL_DOUBLE_TAP_DISTANCE_PX = 32;
const MOBILE_TERMINAL_DOUBLE_TAP_DELAY_MS = 420;
const MOBILE_TERMINAL_TAB_SWIPE_DISTANCE_PX = 72;
const MOBILE_TERMINAL_TAB_SWIPE_RATIO = 1.6;
const MOBILE_TERMINAL_TAB_SWIPE_MAX_MS = 700;

export type MobileTerminalGesture = {
  dx: number;
  dy: number;
  elapsed: number;
  maxDistance: number;
  scrollLocked: boolean;
};

export function isMobileTerminalTapGesture(
  gesture: Pick<MobileTerminalGesture, "maxDistance" | "scrollLocked">,
): boolean {
  return !gesture.scrollLocked
    && gesture.maxDistance <= MOBILE_TERMINAL_TAP_MOVE_THRESHOLD_PX;
}

type MobileTerminalGestureControllerOptions = {
  activateAdjacentTab: (direction: 1 | -1) => void;
};

export function isCoarseTouchPointer(event?: PointerEvent): boolean {
  return event?.pointerType === "touch"
    || window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

export function createMobileTerminalGestureController(options: MobileTerminalGestureControllerOptions) {
  const lastTap = {
    paneId: "",
    time: 0,
    x: 0,
    y: 0,
  };
  return {
    isDoubleTap(paneId: string, event: Pick<PointerEvent, "clientX" | "clientY">): boolean {
      const now = performance.now();
      const dx = event.clientX - lastTap.x;
      const dy = event.clientY - lastTap.y;
      const samePane = lastTap.paneId === paneId;
      const close = dx * dx + dy * dy <= MOBILE_TERMINAL_DOUBLE_TAP_DISTANCE_PX * MOBILE_TERMINAL_DOUBLE_TAP_DISTANCE_PX;
      const fast = now - lastTap.time <= MOBILE_TERMINAL_DOUBLE_TAP_DELAY_MS;
      lastTap.paneId = paneId;
      lastTap.time = now;
      lastTap.x = event.clientX;
      lastTap.y = event.clientY;
      return samePane && close && fast;
    },
    clearTap() {
      lastTap.paneId = "";
      lastTap.time = 0;
    },
    runSwipe(gesture: MobileTerminalGesture): boolean {
      if (
        gesture.scrollLocked
        || gesture.elapsed > MOBILE_TERMINAL_TAB_SWIPE_MAX_MS
        || Math.abs(gesture.dx) < MOBILE_TERMINAL_TAB_SWIPE_DISTANCE_PX
        || Math.abs(gesture.dx) < Math.abs(gesture.dy) * MOBILE_TERMINAL_TAB_SWIPE_RATIO
      ) {
        return false;
      }
      options.activateAdjacentTab(gesture.dx < 0 ? 1 : -1);
      return true;
    },
    isTapGesture(
      gesture: Pick<MobileTerminalGesture, "maxDistance" | "scrollLocked">,
    ): boolean {
      return isMobileTerminalTapGesture(gesture);
    },
  };
}
