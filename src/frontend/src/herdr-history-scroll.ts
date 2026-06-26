import type { HerdrSocketEnvelope, JsonRecord, TerminalPane } from "./types";

const HERDR_HISTORY_LINES = 1000;
const TOUCH_SCROLL_THRESHOLD_PX = 6;
const SCROLL_BOTTOM_EPSILON_PX = 2;

export type HerdrHistoryScrollController = {
  hide(): void;
  dispose(): void;
};

export type HerdrHistoryScrollOptions = {
  pane: TerminalPane;
  ensureHerdrSocketReady: (pane: TerminalPane) => Promise<string>;
  currentHerdrPaneId: (selector: string) => Promise<string>;
  runHerdrSocketRequest: (
    method: string,
    params: JsonRecord,
    options: { selector?: string; id?: string; mirrorNotification?: boolean },
  ) => Promise<HerdrSocketEnvelope>;
  focusPane: (pane: TerminalPane) => void;
  reportError?: (message: string) => void;
};

type TouchScrollState = {
  pointerId: number;
  lastY: number;
  active: boolean;
};

export function installHerdrHistoryScroll(options: HerdrHistoryScrollOptions): HerdrHistoryScrollController {
  const { pane } = options;
  const overlay = document.createElement("div");
  overlay.className = "herdr-history-overlay";
  overlay.hidden = true;
  overlay.setAttribute("aria-hidden", "true");

  const content = document.createElement("pre");
  content.className = "herdr-history-content";
  overlay.appendChild(content);
  pane.mount.appendChild(overlay);

  let disposed = false;
  let visible = false;
  let loading: Promise<boolean> | undefined;
  let requestGeneration = 0;
  let touchScroll: TouchScrollState | undefined;

  const hide = () => {
    if (disposed) return;
    requestGeneration += 1;
    loading = undefined;
    touchScroll = undefined;
    visible = false;
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
  };

  const openHistory = (initialDeltaPx: number) => {
    if (disposed || loading) return loading;
    const generation = requestGeneration;
    loading = loadHistorySnapshot(options)
      .then((text) => {
        loading = undefined;
        if (disposed || generation !== requestGeneration || !text.trim()) return false;
        showHistoryText(text, initialDeltaPx);
        return true;
      })
      .catch((error) => {
        loading = undefined;
        if (!disposed) {
          options.reportError?.(error instanceof Error ? error.message : String(error));
        }
        return false;
      });
    return loading;
  };

  const onWheel = (event: WheelEvent) => {
    if (disposed) return;
    const deltaPx = normalizedWheelDeltaPx(event, pane.mount);
    if (!Number.isFinite(deltaPx) || Math.abs(deltaPx) < 0.5) return;

    if (visible) {
      if (deltaPx > 0 && historyAtBottom(content)) {
        hide();
        return;
      }
      consumeScrollEvent(event);
      scrollHistoryContent(content, deltaPx);
      if (deltaPx > 0 && historyAtBottom(content)) {
        hide();
        options.focusPane(pane);
      }
      return;
    }

    if (loading) {
      if (deltaPx < 0) {
        consumeScrollEvent(event);
      } else {
        cancelPendingHistoryLoad();
      }
      return;
    }

    if (deltaPx < 0) {
      consumeScrollEvent(event);
      void openHistory(deltaPx);
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (disposed) return;
    if (event.pointerType === "touch") {
      touchScroll = {
        pointerId: event.pointerId,
        lastY: event.clientY,
        active: false,
      };
      return;
    }
    if (visible) {
      hide();
      options.focusPane(pane);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    if (disposed || event.pointerType !== "touch") return;
    if (!touchScroll || touchScroll.pointerId !== event.pointerId) return;
    const deltaPx = touchScroll.lastY - event.clientY;
    if (!touchScroll.active && Math.abs(deltaPx) < TOUCH_SCROLL_THRESHOLD_PX) return;

    if (visible) {
      if (deltaPx > 0 && historyAtBottom(content)) {
        hide();
        return;
      }
      touchScroll.active = true;
      touchScroll.lastY = event.clientY;
      consumeScrollEvent(event);
      scrollHistoryContent(content, deltaPx);
      if (deltaPx > 0 && historyAtBottom(content)) {
        hide();
        options.focusPane(pane);
      }
      return;
    }

    if (loading) {
      if (deltaPx < 0) {
        touchScroll.active = true;
        touchScroll.lastY = event.clientY;
        consumeScrollEvent(event);
      } else {
        cancelPendingHistoryLoad();
      }
      return;
    }

    if (deltaPx < 0) {
      touchScroll.active = true;
      touchScroll.lastY = event.clientY;
      consumeScrollEvent(event);
      void openHistory(deltaPx);
    }
  };

  const stopTouchScroll = (event: PointerEvent) => {
    if (touchScroll?.pointerId === event.pointerId) {
      touchScroll = undefined;
    }
  };

  pane.mount.addEventListener("wheel", onWheel, { capture: true, passive: false });
  pane.mount.addEventListener("pointerdown", onPointerDown, { capture: true, passive: false });
  pane.mount.addEventListener("pointermove", onPointerMove, { capture: true, passive: false });
  pane.mount.addEventListener("pointerup", stopTouchScroll, true);
  pane.mount.addEventListener("pointercancel", stopTouchScroll, true);
  pane.mount.addEventListener("lostpointercapture", stopTouchScroll, true);

  function cancelPendingHistoryLoad() {
    requestGeneration += 1;
    loading = undefined;
  }

  function showHistoryText(text: string, initialDeltaPx: number) {
    requestGeneration += 1;
    const generation = requestGeneration;
    content.textContent = ensureTrailingNewline(text);
    visible = true;
    overlay.hidden = false;
    overlay.setAttribute("aria-hidden", "false");

    requestAnimationFrame(() => {
      if (disposed || !visible || generation !== requestGeneration) return;
      content.scrollTop = Math.max(0, content.scrollHeight - content.clientHeight);
      if (!historyCanScroll(content)) {
        hide();
        return;
      }
      scrollHistoryContent(content, initialDeltaPx);
    });
  }

  return {
    hide,
    dispose() {
      if (disposed) return;
      disposed = true;
      requestGeneration += 1;
      loading = undefined;
      touchScroll = undefined;
      pane.mount.removeEventListener("wheel", onWheel, true);
      pane.mount.removeEventListener("pointerdown", onPointerDown, true);
      pane.mount.removeEventListener("pointermove", onPointerMove, true);
      pane.mount.removeEventListener("pointerup", stopTouchScroll, true);
      pane.mount.removeEventListener("pointercancel", stopTouchScroll, true);
      pane.mount.removeEventListener("lostpointercapture", stopTouchScroll, true);
      overlay.remove();
    },
  };
}

async function loadHistorySnapshot(options: HerdrHistoryScrollOptions): Promise<string> {
  const selector = await options.ensureHerdrSocketReady(options.pane);
  const paneId = await options.currentHerdrPaneId(selector);
  const envelope = await options.runHerdrSocketRequest("pane.read", {
    pane_id: paneId,
    source: "recent",
    lines: HERDR_HISTORY_LINES,
    format: "text",
  }, {
    selector,
    id: `lazycat-webshell:herdr-history:${options.pane.id}`,
    mirrorNotification: false,
  });
  return herdrPaneReadText(envelope.result);
}

export function herdrPaneReadText(result: JsonRecord | undefined): string {
  const read = recordField(result, "read");
  const direct = rawStringField(read, "text")
    || rawStringField(result, "text")
    || rawStringField(result, "content")
    || rawStringField(result, "output")
    || rawStringField(result, "data");
  if (direct) return direct;

  const pane = recordField(result, "pane");
  const nested = rawStringField(pane, "text")
    || rawStringField(pane, "content")
    || rawStringField(pane, "output")
    || rawStringField(pane, "data");
  if (nested) return nested;

  const lines = stringArrayField(read, "lines")
    .concat(stringArrayField(result, "lines"))
    .concat(stringArrayField(pane, "lines"));
  return lines.join("\n");
}

function recordField(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}

function rawStringField(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

function stringArrayField(record: JsonRecord | undefined, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizedWheelDeltaPx(event: WheelEvent, fallbackHost: HTMLElement): number {
  if (event.deltaMode === 1) return event.deltaY * 40;
  if (event.deltaMode === 2) return event.deltaY * Math.max(1, fallbackHost.clientHeight);
  return event.deltaY;
}

function scrollHistoryContent(content: HTMLElement, deltaPx: number) {
  const maxScrollTop = Math.max(0, content.scrollHeight - content.clientHeight);
  content.scrollTop = clamp(content.scrollTop + deltaPx, 0, maxScrollTop);
}

function historyCanScroll(content: HTMLElement): boolean {
  return content.scrollHeight > content.clientHeight + SCROLL_BOTTOM_EPSILON_PX;
}

function historyAtBottom(content: HTMLElement): boolean {
  return content.scrollTop + content.clientHeight >= content.scrollHeight - SCROLL_BOTTOM_EPSILON_PX;
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function consumeScrollEvent(event: WheelEvent | PointerEvent) {
  event.preventDefault();
  event.stopImmediatePropagation();
}
