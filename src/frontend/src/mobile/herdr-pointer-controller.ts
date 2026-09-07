type TouchPoint = PointerEvent;

export type HerdrPointerControllerOptions = {
  root: EventTarget;
  globalTarget: EventTarget;
  visibilityTarget: EventTarget;
  canvas: () => HTMLCanvasElement | null;
  enabled: () => boolean;
  ready?: () => boolean;
  connection: () => unknown;
  moveThresholdPx: number;
  now?: () => number;
  sendTap?: (canvas: HTMLCanvasElement, event: PointerEvent) => void;
};

const LONG_PRESS_MS = 450;

/** Restty routes touch presses to application mouse but omits their release.
 * Wait for a tap, then let its native mouse encoder send a complete pair.
 * Touch scrolling remains owned by the pane's scrollback fallback.
 */
export function installHerdrPointerController(options: HerdrPointerControllerOptions): () => void {
  const now = options.now ?? performance.now.bind(performance);
  const sendTap = options.sendTap ?? dispatchHerdrTap;
  let disposed = false;
  let touch: {
    id: number;
    x: number;
    y: number;
    startedAt: number;
    moved: boolean;
    canvas: HTMLCanvasElement;
    connection: unknown;
    ready: boolean;
  } | undefined;

  const clear = () => { touch = undefined; };
  const onDown = (source: Event) => {
    const event = source as TouchPoint;
    if (event.pointerType !== "touch" || event.shiftKey || !options.enabled()) return;
    const canvas = options.canvas();
    if (!canvas || event.target !== canvas) return;
    if (touch || event.isPrimary === false) {
      if (touch) touch.moved = true;
      event.stopPropagation();
      return;
    }
    touch = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      startedAt: now(), moved: false, canvas, connection: options.connection(),
      ready: options.ready?.() !== false,
    };
    // Do not preventDefault: the existing keyboard/gesture guards still observe
    // this pointer, and touch scrolling needs its regular capture listeners.
    event.stopPropagation();
  };
  const onMove = (source: Event) => {
    const event = source as TouchPoint;
    if (!touch || touch.id !== event.pointerId) return;
    touch.moved ||= Math.hypot(event.clientX - touch.x, event.clientY - touch.y) >= options.moveThresholdPx;
    event.stopPropagation();
  };
  const onUp = (source: Event) => {
    const event = source as TouchPoint;
    if (!touch || touch.id !== event.pointerId) return;
    const current = touch;
    clear();
    event.stopPropagation();
    if (disposed || event.defaultPrevented || !options.enabled() || event.shiftKey
      || !current.ready || options.ready?.() === false
      || current.moved || now() - current.startedAt >= LONG_PRESS_MS
      || Math.hypot(event.clientX - current.x, event.clientY - current.y) >= options.moveThresholdPx
      || current.canvas !== options.canvas() || current.connection !== options.connection()) return;
    sendTap(current.canvas, event);
  };
  const onEndOutside = (source: Event) => {
    if (touch?.id === (source as TouchPoint).pointerId) clear();
  };
  const onAdditionalTouch = (source: Event) => {
    const event = source as TouchPoint;
    if (touch && event.pointerType === "touch" && event.pointerId !== touch.id) touch.moved = true;
  };

  options.root.addEventListener("pointerdown", onDown, true);
  options.root.addEventListener("pointermove", onMove, true);
  options.root.addEventListener("pointerup", onUp, true);
  options.globalTarget.addEventListener("pointerdown", onAdditionalTouch, true);
  options.globalTarget.addEventListener("pointerup", onEndOutside);
  options.globalTarget.addEventListener("pointercancel", onEndOutside, true);
  options.globalTarget.addEventListener("lostpointercapture", onEndOutside, true);
  options.globalTarget.addEventListener("blur", clear);
  options.visibilityTarget.addEventListener("visibilitychange", clear);

  return () => {
    if (disposed) return;
    disposed = true;
    clear();
    options.root.removeEventListener("pointerdown", onDown, true);
    options.root.removeEventListener("pointermove", onMove, true);
    options.root.removeEventListener("pointerup", onUp, true);
    options.globalTarget.removeEventListener("pointerdown", onAdditionalTouch, true);
    options.globalTarget.removeEventListener("pointerup", onEndOutside);
    options.globalTarget.removeEventListener("pointercancel", onEndOutside, true);
    options.globalTarget.removeEventListener("lostpointercapture", onEndOutside, true);
    options.globalTarget.removeEventListener("blur", clear);
    options.visibilityTarget.removeEventListener("visibilitychange", clear);
  };
}

export function dispatchHerdrTap(canvas: HTMLCanvasElement, event: PointerEvent): void {
  const coordinates: PointerEventInit = {
    bubbles: true, cancelable: true, pointerId: event.pointerId,
    pointerType: "mouse", isPrimary: true, button: 0,
    clientX: event.clientX, clientY: event.clientY,
    screenX: event.screenX, screenY: event.screenY,
    ctrlKey: event.ctrlKey, altKey: event.altKey,
    shiftKey: event.shiftKey, metaKey: event.metaKey,
  };
  canvas.dispatchEvent(new PointerEvent("pointerdown", { ...coordinates, buttons: 1 }));
  canvas.dispatchEvent(new PointerEvent("pointerup", { ...coordinates, buttons: 0 }));
}
