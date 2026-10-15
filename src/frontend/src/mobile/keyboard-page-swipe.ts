type Page = "typing" | "function";

const SWIPE_DISTANCE_PX = 72;
const SWIPE_AXIS_RATIO = 1.5;

export function installMobileKeyboardPageSwipe(options: {
  root: EventTarget;
  globalTarget?: EventTarget;
  activePage: () => string;
  activatePage: (page: Page) => void;
  visibilityTarget?: EventTarget;
}) {
  const globalTarget = options.globalTarget ?? window;
  let gesture: { id: number; page: Page; x: number; y: number; lastX: number; lastY: number } | undefined;
  const clear = () => { gesture = undefined; };

  const onDown = (source: Event) => {
    const event = source as PointerEvent;
    if (event.pointerType !== "touch" || event.isPrimary === false || gesture) {
      clear();
      return;
    }
    const page = options.activePage();
    if (page !== "typing" && page !== "function") return;
    gesture = { id: event.pointerId, page, x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY };
  };
  const onMove = (source: Event) => {
    const event = source as PointerEvent;
    if (gesture?.id !== event.pointerId) return;
    gesture.lastX = event.clientX;
    gesture.lastY = event.clientY;
  };
  const onUp = (source: Event) => {
    const event = source as PointerEvent;
    if (gesture?.id !== event.pointerId) return;
    const { page, x, y } = gesture;
    clear();
    const dx = event.clientX - x;
    const dy = event.clientY - y;
    if (Math.abs(dx) < SWIPE_DISTANCE_PX || Math.abs(dx) < Math.abs(dy) * SWIPE_AXIS_RATIO) return;
    if (page === "typing" && dx < 0) options.activatePage("function");
    if (page === "function" && dx > 0) options.activatePage("typing");
  };

  options.root.addEventListener("pointerdown", onDown);
  globalTarget.addEventListener("pointermove", onMove);
  globalTarget.addEventListener("pointerup", onUp);
  globalTarget.addEventListener("pointercancel", clear);
  options.visibilityTarget?.addEventListener("visibilitychange", clear);

  return () => {
    clear();
    options.root.removeEventListener("pointerdown", onDown);
    globalTarget.removeEventListener("pointermove", onMove);
    globalTarget.removeEventListener("pointerup", onUp);
    globalTarget.removeEventListener("pointercancel", clear);
    options.visibilityTarget?.removeEventListener("visibilitychange", clear);
  };
}
