type Row = HTMLElement & { dataset: DOMStringMap };
type Scheduler = {
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (id: number) => void;
  requestAnimationFrame: (callback: () => void) => number;
  cancelAnimationFrame: (id: number) => void;
};

const HOLD_MS = 380;
const SCROLL_THRESHOLD_PX = 8;

export function installMobileKeyboardReorderGesture(options: {
  root: HTMLElement;
  list: HTMLElement;
  scrollHost: HTMLElement | null;
  move: (sourceId: string, targetId: string) => void;
  scheduler?: Scheduler;
  hitTest?: (x: number, y: number) => Element | null;
  windowTarget?: EventTarget;
  visibilityTarget?: EventTarget;
}) {
  const scheduler = options.scheduler ?? window;
  const windowTarget = options.windowTarget ?? window;
  const visibilityTarget = options.visibilityTarget ?? document;
  const hitTest = options.hitTest ?? ((x: number, y: number) => options.list.ownerDocument.elementFromPoint(x, y));
  let press: { id: number; sourceId: string; x: number; y: number; lastY: number; timer: number } | undefined;
  let drag: { id: number; sourceId: string; targetId: string; x: number; y: number } | undefined;
  const scrollPointers = new Map<number, { y: number; moved: boolean }>();
  let scrollFrame = 0;
  let suppressedClick: { x: number; y: number; until: number } | undefined;

  const rowFor = (target: EventTarget | null): Row | null => {
    const row = (target as Element | null)?.closest?.<Row>("[data-mobile-layout-key]") ?? null;
    return row && options.list.contains(row) ? row : null;
  };

  const clearPress = () => {
    if (press?.timer) scheduler.clearTimeout(press.timer);
    press = undefined;
  };

  const stopAutoScroll = () => {
    if (scrollFrame) scheduler.cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
  };

  const clearDrag = () => {
    stopAutoScroll();
    const current = drag;
    drag = undefined;
    if (current) {
      try {
        if (options.list.hasPointerCapture?.(current.id)) options.list.releasePointerCapture(current.id);
      } catch { /* Capture may already have ended. */ }
    }
    options.list.querySelectorAll(".is-dragging, .is-drag-over").forEach((row) => row.classList.remove("is-dragging", "is-drag-over"));
  };

  const releaseScrollCapture = (id: number) => {
    try {
      if (options.list.hasPointerCapture?.(id)) options.list.releasePointerCapture(id);
    } catch { /* Capture may already have ended. */ }
  };

  const cancel = () => {
    clearPress();
    clearDrag();
    for (const id of scrollPointers.keys()) releaseScrollCapture(id);
    scrollPointers.clear();
  };

  const targetRow = (x: number, y: number): Row | null => {
    const hit = rowFor(hitTest(x, y));
    if (hit) return hit;
    const rows = options.list.querySelectorAll<Row>("[data-mobile-layout-key]");
    if (!rows.length) return null;
    if (y < rows[0].getBoundingClientRect().top) return rows[0];
    if (y > rows[rows.length - 1].getBoundingClientRect().bottom) return rows[rows.length - 1];
    return null;
  };

  const updateTarget = () => {
    if (!drag) return;
    const row = targetRow(drag.x, drag.y);
    options.list.querySelectorAll(".is-drag-over").forEach((item) => item.classList.remove("is-drag-over"));
    if (row) {
      row.classList.add("is-drag-over");
      drag.targetId = row.dataset.mobileLayoutKey ?? drag.sourceId;
    }
  };

  const scheduleAutoScroll = () => {
    stopAutoScroll();
    const host = options.scrollHost;
    if (!drag || !host || scrollPointers.size) return;
    const bounds = host.getBoundingClientRect();
    const edge = Math.min(64, (bounds.bottom - bounds.top) / 3);
    if (edge <= 0) return;
    const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight);
    const top = drag.y < bounds.top + edge && host.scrollTop > 0;
    const bottom = drag.y > bounds.bottom - edge && host.scrollTop < maxScroll;
    if (!top && !bottom) return;
    const proximity = top
      ? Math.min(1, (bounds.top + edge - drag.y) / edge)
      : Math.min(1, (drag.y - bounds.bottom + edge) / edge);
    const step = (top ? -1 : 1) * (3 + 17 * proximity * proximity);
    scrollFrame = scheduler.requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!drag || scrollPointers.size) return;
      const before = host.scrollTop;
      host.scrollTop = Math.max(0, Math.min(maxScroll, before + step));
      if (host.scrollTop !== before) {
        updateTarget();
        scheduleAutoScroll();
      }
    });
  };

  const onDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" || event.button !== 0) return;
    if (drag) {
      scrollPointers.set(event.pointerId, { y: event.clientY, moved: true });
      try { options.list.setPointerCapture?.(event.pointerId); } catch { /* The finger may have left. */ }
      stopAutoScroll();
      return;
    }
    if (press) clearPress();
    if (scrollPointers.size) {
      scrollPointers.set(event.pointerId, { y: event.clientY, moved: false });
      return;
    }
    const row = rowFor(event.target);
    if (!row?.dataset.mobileLayoutKey) return;
    const pending = {
      id: event.pointerId, sourceId: row.dataset.mobileLayoutKey,
      x: event.clientX, y: event.clientY, lastY: event.clientY, timer: 0,
    };
    press = pending;
    pending.timer = scheduler.setTimeout(() => {
      if (press !== pending) return;
      press = undefined;
      drag = { id: pending.id, sourceId: pending.sourceId, targetId: pending.sourceId, x: pending.x, y: pending.lastY };
      row.classList.add("is-dragging");
      try { options.list.setPointerCapture?.(pending.id); } catch { /* The finger may have left. */ }
      updateTarget();
      scheduleAutoScroll();
    }, HOLD_MS);
  };

  const onMove = (event: PointerEvent) => {
    if (press?.id === event.pointerId) {
      const pending = press;
      pending.lastY = event.clientY;
      if (Math.hypot(event.clientX - pending.x, event.clientY - pending.y) <= SCROLL_THRESHOLD_PX) return;
      clearPress();
      scrollPointers.set(event.pointerId, { y: pending.y, moved: true });
      try { options.list.setPointerCapture?.(event.pointerId); } catch { /* The finger may have left. */ }
    }
    if (drag?.id === event.pointerId) {
      event.preventDefault();
      drag.x = event.clientX;
      drag.y = event.clientY;
      updateTarget();
      scheduleAutoScroll();
      return;
    }
    const scrolling = scrollPointers.get(event.pointerId);
    if (!scrolling) return;
    event.preventDefault();
    if (options.scrollHost) options.scrollHost.scrollTop += scrolling.y - event.clientY;
    scrolling.moved ||= Math.abs(scrolling.y - event.clientY) > 0;
    scrolling.y = event.clientY;
    updateTarget();
  };

  const onEnd = (event: PointerEvent, cancelled: boolean) => {
    if (press?.id === event.pointerId) {
      clearPress();
      return;
    }
    if (drag?.id === event.pointerId) {
      const { sourceId, targetId } = drag;
      clearDrag();
      suppressedClick = { x: event.clientX, y: event.clientY, until: Date.now() + 500 };
      if (!cancelled && sourceId !== targetId) options.move(sourceId, targetId);
      return;
    }
    const scrolling = scrollPointers.get(event.pointerId);
    if (!scrolling) return;
    scrollPointers.delete(event.pointerId);
    releaseScrollCapture(event.pointerId);
    if (scrolling.moved && !cancelled) {
      suppressedClick = { x: event.clientX, y: event.clientY, until: Date.now() + 500 };
    }
    scheduleAutoScroll();
  };

  const onClick = (event: MouseEvent) => {
    if (suppressedClick && Date.now() > suppressedClick.until) suppressedClick = undefined;
    if (!event.detail || !suppressedClick) return;
    if (Math.hypot(event.clientX - suppressedClick.x, event.clientY - suppressedClick.y) > 24) return;
    suppressedClick = undefined;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onContextMenu = (event: MouseEvent) => {
    if (suppressedClick && Date.now() > suppressedClick.until) suppressedClick = undefined;
    if (drag || press || suppressedClick) event.preventDefault();
  };

  const onUp = (event: PointerEvent) => onEnd(event, false);
  const onCancel = (event: PointerEvent) => onEnd(event, true);

  options.root.addEventListener("pointerdown", onDown);
  options.root.addEventListener("pointermove", onMove);
  options.root.addEventListener("pointerup", onUp);
  options.root.addEventListener("pointercancel", onCancel);
  options.root.addEventListener("lostpointercapture", onCancel);
  options.root.addEventListener("click", onClick, true);
  options.root.addEventListener("contextmenu", onContextMenu, true);
  windowTarget.addEventListener("blur", cancel);
  visibilityTarget.addEventListener("visibilitychange", cancel);

  return { cancel, dispose: () => {
    cancel();
    options.root.removeEventListener("pointerdown", onDown);
    options.root.removeEventListener("pointermove", onMove);
    options.root.removeEventListener("pointerup", onUp);
    options.root.removeEventListener("pointercancel", onCancel);
    options.root.removeEventListener("lostpointercapture", onCancel);
    options.root.removeEventListener("click", onClick, true);
    options.root.removeEventListener("contextmenu", onContextMenu, true);
    windowTarget.removeEventListener("blur", cancel);
    visibilityTarget.removeEventListener("visibilitychange", cancel);
  } };
}
