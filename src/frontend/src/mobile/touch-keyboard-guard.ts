export type ReadOnlyInput = {
  readOnly: boolean;
};

export type TouchKeyboardReadOnlyGuardOptions = {
  pane: EventTarget;
  globalTarget: EventTarget;
  visibilityTarget: EventTarget;
  input: () => ReadOnlyInput | null;
  scrollLockThresholdPx: number;
  scrollAxisRatio: number;
};

type PointerLikeEvent = Event & {
  pointerId?: number;
  pointerType?: string;
  clientX?: number;
  clientY?: number;
};

export function installTouchKeyboardReadOnlyGuard(
  options: TouchKeyboardReadOnlyGuardOptions,
): () => void {
  let touchPointerId: number | undefined;
  let startX = 0;
  let startY = 0;
  let suppressInput: ReadOnlyInput | null = null;
  let suppressInputReadOnly = false;
  let scrollLocked = false;
  let deferredRestore: ReturnType<typeof setTimeout> | undefined;

  const restoreInput = () => {
    if (deferredRestore !== undefined) {
      clearTimeout(deferredRestore);
      deferredRestore = undefined;
    }
    if (suppressInput) {
      suppressInput.readOnly = suppressInputReadOnly;
      suppressInput = null;
    }
    touchPointerId = undefined;
    scrollLocked = false;
  };

  const restoreInputAfterGesture = () => {
    touchPointerId = undefined;
    scrollLocked = false;
    deferredRestore = setTimeout(restoreInput, 0);
  };

  const stopTouch = (event: Event) => {
    const pointerId = pointerEvent(event).pointerId;
    if (touchPointerId === undefined || pointerId !== touchPointerId) return;
    if (event.type === "pointerup" && scrollLocked) {
      restoreInputAfterGesture();
      return;
    }
    restoreInput();
  };

  const onPointerDown = (event: Event) => {
    const pointer = pointerEvent(event);
    if (pointer.pointerType !== "touch" || pointer.pointerId === undefined) return;
    restoreInput();
    touchPointerId = pointer.pointerId;
    startX = pointer.clientX ?? 0;
    startY = pointer.clientY ?? 0;
    suppressInput = options.input();
    if (suppressInput) {
      suppressInputReadOnly = suppressInput.readOnly;
      suppressInput.readOnly = true;
    }
  };

  const onPointerMove = (event: Event) => {
    const pointer = pointerEvent(event);
    if (touchPointerId !== pointer.pointerId || scrollLocked) return;
    const dx = (pointer.clientX ?? startX) - startX;
    const dy = (pointer.clientY ?? startY) - startY;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    if (Math.hypot(dx, dy) < options.scrollLockThresholdPx) return;
    if (absDy < absDx * options.scrollAxisRatio) return;
    scrollLocked = true;
  };

  options.pane.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
  options.pane.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
  options.globalTarget.addEventListener("pointerup", stopTouch, true);
  options.globalTarget.addEventListener("pointercancel", stopTouch, true);
  options.globalTarget.addEventListener("blur", restoreInput);
  options.visibilityTarget.addEventListener("visibilitychange", restoreInput);

  return () => {
    restoreInput();
    options.pane.removeEventListener("pointerdown", onPointerDown, true);
    options.pane.removeEventListener("pointermove", onPointerMove, true);
    options.globalTarget.removeEventListener("pointerup", stopTouch, true);
    options.globalTarget.removeEventListener("pointercancel", stopTouch, true);
    options.globalTarget.removeEventListener("blur", restoreInput);
    options.visibilityTarget.removeEventListener("visibilitychange", restoreInput);
  };
}

function pointerEvent(event: Event): PointerLikeEvent {
  return event as PointerLikeEvent;
}
