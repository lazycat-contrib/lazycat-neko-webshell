type KeyPointer = PointerEvent;

/** Own physical key gestures until release; a scroll must not send an initial byte. */
export function createMobileKeyGestureController<T>(options: {
  root: EventTarget;
  globalTarget: EventTarget;
  visibilityTarget?: EventTarget;
  button: (target: EventTarget | null) => T | undefined;
  usable: (button: T) => boolean;
  inside: (button: T, x: number, y: number) => boolean;
  repeat: (button: T) => boolean;
  start: (button: T) => void;
  activate: (button: T, repeating: boolean) => void;
  finish: (button: T, repeated: boolean) => void;
  capture?: (button: T, id: number) => void;
  release?: (button: T, id: number) => void;
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
  moveThresholdPx?: number;
}) {
  const threshold = options.moveThresholdPx ?? 8;
  let current: { button: T; id: number; x: number; y: number; repeated: boolean } | undefined;
  let timer: number | undefined;
  let disposed = false;
  const blocked = new Set<number>();
  function stopTimer() {
    if (timer !== undefined) options.clearTimer(timer);
    timer = undefined;
  }
  function finish() {
    const previous = current;
    current = undefined;
    stopTimer();
    if (!previous) return;
    options.release?.(previous.button, previous.id);
    options.finish(previous.button, previous.repeated);
  }
  function cancelAll() { finish(); blocked.clear(); }
  function startRepeat(delay: number) {
    const gesture = current;
    if (!gesture) return;
    timer = options.setTimer(() => {
      timer = undefined;
      if (disposed || current !== gesture) return;
      if (!options.usable(gesture.button)) { finish(); return; }
      gesture.repeated = true;
      options.activate(gesture.button, true);
      if (current === gesture) startRepeat(86);
    }, delay);
  }
  function onAdditionalPointer(source: Event) {
    const event = source as KeyPointer;
    if (current && event.pointerId !== current.id) {
      blocked.add(current.id);
      blocked.add(event.pointerId);
      finish();
    }
  }
  function onDown(source: Event) {
    const event = source as KeyPointer;
    const button = options.button(event.target);
    if (disposed || event.button !== 0 || event.isPrimary === false || blocked.has(event.pointerId)
      || !button || !options.usable(button)) return;
    finish();
    options.start(button);
    // Preserve IME focus. Native pan still delivers move/cancel according to touch-action.
    event.preventDefault();
    current = { button, id: event.pointerId, x: event.clientX, y: event.clientY, repeated: false };
    options.capture?.(button, event.pointerId);
    if (options.repeat(button)) startRepeat(360);
  }
  function onMove(source: Event) {
    const event = source as KeyPointer;
    if (!current || current.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - current.x, event.clientY - current.y) >= threshold
      || !options.inside(current.button, event.clientX, event.clientY)) finish();
  }
  function onUp(source: Event) {
    const event = source as KeyPointer;
    blocked.delete(event.pointerId);
    const gesture = current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const valid = !event.defaultPrevented && options.usable(gesture.button)
      && options.inside(gesture.button, event.clientX, event.clientY)
      && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < threshold;
    if (valid) {
      event.preventDefault();
      // This call remains synchronous in pointerup for system-keyboard activation.
      if (!gesture.repeated) options.activate(gesture.button, false);
    }
    finish();
  }
  function onCancel(source: Event) {
    const event = source as KeyPointer;
    blocked.delete(event.pointerId);
    if (current?.id === event.pointerId) finish();
  }
  function onClick(source: Event) {
    const event = source as MouseEvent;
    const button = options.button(event.target);
    if (disposed || !button) return;
    event.preventDefault();
    event.stopPropagation();
    // Physical clicks already committed on release (or were canceled). detail=0
    // is keyboard/AT activation and must remain usable without pointer events.
    if (event.detail === 0 && options.usable(button)) {
      finish();
      options.start(button);
      options.activate(button, false);
      options.finish(button, false);
    }
  }
  options.root.addEventListener("pointerdown", onDown, true);
  options.root.addEventListener("click", onClick);
  options.root.addEventListener("scroll", cancelAll, true);
  options.globalTarget.addEventListener("pointerdown", onAdditionalPointer, true);
  options.globalTarget.addEventListener("pointermove", onMove, true);
  options.globalTarget.addEventListener("pointerup", onUp);
  options.globalTarget.addEventListener("pointercancel", onCancel, true);
  options.globalTarget.addEventListener("lostpointercapture", onCancel, true);
  options.globalTarget.addEventListener("blur", cancelAll);
  options.globalTarget.addEventListener("pagehide", cancelAll);
  options.visibilityTarget?.addEventListener("visibilitychange", cancelAll);
  return {
    cancel: cancelAll,
    dispose() {
      if (disposed) return;
      disposed = true; finish(); blocked.clear();
      options.root.removeEventListener("pointerdown", onDown, true);
      options.root.removeEventListener("click", onClick);
      options.root.removeEventListener("scroll", cancelAll, true);
      options.globalTarget.removeEventListener("pointerdown", onAdditionalPointer, true);
      options.globalTarget.removeEventListener("pointermove", onMove, true);
      options.globalTarget.removeEventListener("pointerup", onUp);
      options.globalTarget.removeEventListener("pointercancel", onCancel, true);
      options.globalTarget.removeEventListener("lostpointercapture", onCancel, true);
      options.globalTarget.removeEventListener("blur", cancelAll);
      options.globalTarget.removeEventListener("pagehide", cancelAll);
      options.visibilityTarget?.removeEventListener("visibilitychange", cancelAll);
    },
  };
}
