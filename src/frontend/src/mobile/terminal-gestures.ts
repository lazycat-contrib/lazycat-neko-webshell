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
};

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
  const swipe = {
    paneId: "",
    x: 0,
    y: 0,
    time: 0,
  };

  return {
    isDoubleTap(paneId: string, event: PointerEvent): boolean {
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
    trackSwipeStart(paneId: string, event: PointerEvent) {
      if (event.pointerType !== "touch") return;
      swipe.paneId = paneId;
      swipe.x = event.clientX;
      swipe.y = event.clientY;
      swipe.time = performance.now();
    },
    readGesture(paneId: string, event: PointerEvent): MobileTerminalGesture | undefined {
      if (event.pointerType !== "touch" || swipe.paneId !== paneId) return undefined;
      return {
        dx: event.clientX - swipe.x,
        dy: event.clientY - swipe.y,
        elapsed: performance.now() - swipe.time,
      };
    },
    clearGesture() {
      swipe.paneId = "";
    },
    runSwipe(gesture: MobileTerminalGesture): boolean {
      if (
        gesture.elapsed > MOBILE_TERMINAL_TAB_SWIPE_MAX_MS
        || Math.abs(gesture.dx) < MOBILE_TERMINAL_TAB_SWIPE_DISTANCE_PX
        || Math.abs(gesture.dx) < Math.abs(gesture.dy) * MOBILE_TERMINAL_TAB_SWIPE_RATIO
      ) {
        return false;
      }
      options.activateAdjacentTab(gesture.dx < 0 ? 1 : -1);
      return true;
    },
    isTapGesture(gesture: Pick<MobileTerminalGesture, "dx" | "dy">): boolean {
      return Math.hypot(gesture.dx, gesture.dy) <= MOBILE_TERMINAL_TAP_MOVE_THRESHOLD_PX;
    },
  };
}
