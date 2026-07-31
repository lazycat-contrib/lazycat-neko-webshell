type HerdrJumpSheetDeps = {
  sheet: HTMLElement;
  isMobile: () => boolean;
  close: () => void;
};

const DISMISS_DISTANCE = 88;
const DISMISS_VELOCITY = 0.45;

export function renderHerdrJumpMobileBackdrop(): string {
  return `<div class="herdr-jump-scrim" data-herdr-jump-dismiss hidden></div>`;
}

export function renderHerdrJumpMobileDragRegion(): string {
  return `
    <div class="herdr-jump-drag-region" data-herdr-jump-drag>
      <span class="herdr-jump-handle" aria-hidden="true"></span>
    </div>
  `;
}

export function renderHerdrJumpMobileCloseButton(): string {
  return `
    <button class="herdr-jump-close" type="button" data-herdr-jump-dismiss aria-label="Close" title="Close" data-i18n-aria="action.close" data-i18n-title="action.close">
      <i data-lucide="x"></i>
    </button>
  `;
}

export function bindHerdrJumpSheetGesture(deps: HerdrJumpSheetDeps): () => void {
  let pointerId: number | undefined;
  let startY = 0;
  let startTime = 0;

  const onPointerDown = (event: PointerEvent) => {
    if (!deps.isMobile() || pointerId !== undefined || event.button !== 0) return;
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest("[data-herdr-jump-drag]")) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startTime = performance.now();
    deps.sheet.setPointerCapture(pointerId);
    deps.sheet.dataset.dragging = "true";
  };
  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    const distance = Math.max(0, event.clientY - startY);
    deps.sheet.style.transform = `translateY(${distance}px)`;
  };
  const finish = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    const distance = Math.max(0, event.clientY - startY);
    const elapsed = Math.max(1, performance.now() - startTime);
    pointerId = undefined;
    deps.sheet.dataset.dragging = "false";
    deps.sheet.releasePointerCapture(event.pointerId);
    deps.sheet.style.transform = "";
    if (distance >= DISMISS_DISTANCE || distance / elapsed >= DISMISS_VELOCITY) deps.close();
  };
  deps.sheet.addEventListener("pointerdown", onPointerDown);
  deps.sheet.addEventListener("pointermove", onPointerMove);
  deps.sheet.addEventListener("pointerup", finish);
  deps.sheet.addEventListener("pointercancel", finish);
  return () => {
    deps.sheet.removeEventListener("pointerdown", onPointerDown);
    deps.sheet.removeEventListener("pointermove", onPointerMove);
    deps.sheet.removeEventListener("pointerup", finish);
    deps.sheet.removeEventListener("pointercancel", finish);
  };
}
