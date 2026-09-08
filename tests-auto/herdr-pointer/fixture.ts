import { installPaneViewportGuard } from "../../src/frontend/src/terminal-viewport";
import { installHerdrPointerController } from "../../src/frontend/src/mobile/herdr-pointer-controller";
import { applyPaneMouseMode } from "../../src/frontend/src/terminal-mouse-mode";
import { createPaneTerminal } from "../../src/frontend/src/terminal-options";
import { installPaneScrollbackFallback } from "../../src/frontend/src/terminal-scrollback";

declare global {
  interface Window {
    __herdrProbe: ReturnType<typeof createProbe>;
  }
}

const mount = document.querySelector<HTMLElement>("#mount");
if (!mount) throw new Error("missing terminal mount");

window.__herdrProbe = createProbe(mount);

function createProbe(root: HTMLElement) {
  let callbacks: { onConnect?: () => void; onData?: (data: string) => void } | undefined;
  let outputOffset = 0;
  let receivedBytes = 0;
  let deliveredBytes = 0;
  let focusReportingObserved = false;
  let transportReportCount = 0;
  let inputQueue = Promise.resolve();
  let disposed = false;
  let connected = false;
  let pointerDispose: (() => void) | undefined;
  let animationFrames = 0;
  const mouseReports: string[] = [];
  const pointerEvents: Array<Record<string, unknown>> = [];
  const errors: string[] = [];
  const decoder = new TextDecoder();

  window.addEventListener("error", (event) => errors.push(String(event.error ?? event.message)));
  window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

  const transport = {
    connect(options: { callbacks: typeof callbacks }) {
      callbacks = options.callbacks;
      connected = true;
      callbacks?.onConnect?.();
    },
    disconnect() { connected = false; },
    sendInput(data: string) {
      transportReportCount++;
      if (data === "\x1b[I" || data === "\x1b[O") focusReportingObserved = true;
      if (/^\x1b\[<\d+;\d+;\d+[Mm]$/.test(data) || data === "\x1b[I" || data === "\x1b[O") {
        mouseReports.push(data);
        if (mouseReports.length > 256) mouseReports.splice(0, mouseReports.length - 256);
      }
      inputQueue = inputQueue.then(async () => {
        const response = await fetch("/__herdr_bridge/input", { method: "POST", body: data });
        if (!response.ok) throw new Error(`bridge input failed: ${response.status}`);
      });
      inputQueue.catch((error) => errors.push(String(error)));
      return true;
    },
    resize(cols: number, rows: number) {
      void fetch("/__herdr_bridge/resize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cols, rows }),
      }).then((response) => {
        if (!response.ok) throw new Error(`bridge resize failed: ${response.status}`);
      }).catch((error) => errors.push(String(error)));
      return true;
    },
    isConnected() {
      return connected;
    },
    destroy() { connected = false; },
  };
  const pane: { mount: HTMLElement; sessionBackend: string; term?: typeof term } = {
    mount: root,
    sessionBackend: "herdr",
  };
  const term = createPaneTerminal({
    cols: 120,
    rows: 35,
    fonts: [{ url: "/__herdr_font", name: "Liberation Mono" }],
    fontSize: 18,
    fontLigatures: false,
    fontHinting: true,
    fontHintTarget: "normal",
    scrollbackLimit: 1000,
    touchSelectionMode: "long-press",
    transport,
    beforeInput: ({ text }) => text,
    contextMenuItems: () => [],
    searchClearButtonText: "Clear",
    searchPlaceholder: "Search",
    onDomReady() {},
    onGridSize() {},
  });
  pane.term = term;
  term.open(root);
  term.restty?.connectPty("isolated-herdr-pointer-test");
  applyPaneMouseMode(pane);
  installPaneScrollbackFallback(pane, { touchSelectionMode: () => "long-press" });
  if (new URLSearchParams(location.search).get("adapter") === "1") installAdapter();
  installPaneViewportGuard(pane, {
    scheduleSizeRefresh: () => requestAnimationFrame(() => {
      term.restty?.updateSize(true);
      transport.resize(term.cols, term.rows);
    }),
  });
  term.focus();

  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) {
    root.addEventListener(
      type,
      (event) => {
        const pointer = event as PointerEvent;
        pointerEvents.push({
          type,
          pointerType: pointer.pointerType,
          pointerId: pointer.pointerId,
          x: pointer.clientX,
          y: pointer.clientY,
          defaultPrevented: pointer.defaultPrevented,
        });
        if (pointerEvents.length > 256) pointerEvents.splice(0, pointerEvents.length - 256);
      },
      true,
    );
  }

  void pollOutput().catch((error) => errors.push(String(error)));
  countFrames();
  window.addEventListener("pagehide", () => { disposed = true; pointerDispose?.(); }, { once: true });

  function installAdapter() {
    pointerDispose?.();
    pointerDispose = installHerdrPointerController({
      root,
      globalTarget: window,
      visibilityTarget: document,
      canvas: () => root.querySelector<HTMLCanvasElement>(".pane-canvas"),
      enabled: () => Boolean(term.restty?.getMouseStatus().active),
      connection: () => transport,
      moveThresholdPx: 6,
    });
  }

  async function pollOutput() {
    const deadline = performance.now() + 20_000;
    while (!disposed && term.restty?.getActivePane()?.runtime.lifecycle.state() !== "ready") {
      const state = term.restty?.getActivePane()?.runtime.lifecycle.state();
      if (state === "failed" || state === "destroyed" || performance.now() >= deadline) {
        throw new Error(`terminal initialization failed: ${state}`);
      }
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    // Initial VT bytes configure mouse/focus reporting. Never consume offset 0
    // before WASM is ready, and use the same transport output path as Neko.
    while (!disposed) {
      const response = await fetch(`/__herdr_bridge/output?offset=${outputOffset}`);
      if (!response.ok) throw new Error(`bridge output failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      outputOffset = Number(response.headers.get("X-Output-End") ?? outputOffset + bytes.length);
      receivedBytes += bytes.length;
      if (bytes.length) {
        if (!callbacks?.onData) throw new Error("terminal output callback is unavailable");
        callbacks.onData(decoder.decode(bytes, { stream: true }));
        deliveredBytes += bytes.length;
        if (!focusReportingObserved) term.focus();
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  function countFrames() {
    if (disposed) return;
    animationFrames += 1;
    requestAnimationFrame(countFrames);
  }

  function canvasPoint(column: number, row: number) {
    const canvas = root.querySelector<HTMLCanvasElement>(".pane-canvas");
    if (!canvas) throw new Error("terminal canvas is unavailable");
    const rect = canvas.getBoundingClientRect();
    return {
      x: rect.left + ((column + 0.5) / term.cols) * rect.width,
      y: rect.top + ((row + 0.5) / term.rows) * rect.height,
    };
  }

  function snapshot() {
    const canvas = root.querySelector<HTMLCanvasElement>(".pane-canvas");
    const rect = canvas?.getBoundingClientRect();
    let rendererBackend = "unknown";
    if (canvas?.getContext("webgl2")) rendererBackend = "webgl2";
    else if (canvas?.getContext("webgpu")) rendererBackend = "webgpu";
    return {
      ready: Boolean(canvas && deliveredBytes > 0 && focusReportingObserved
        && term.restty?.getActivePane()?.runtime.lifecycle.state() === "ready"
        && term.restty?.getMouseStatus().active),
      runtimeState: term.restty?.getActivePane()?.runtime.lifecycle.state(),
      focusReportingObserved,
      deliveredBytes,
      receivedBytes,
      animationFrames,
      rendererBackend,
      canvas: canvas && rect ? {
        width: canvas.width,
        height: canvas.height,
        clientWidth: rect.width,
        clientHeight: rect.height,
      } : null,
      mouseStatus: term.restty?.getMouseStatus() ?? null,
      mouseReports: mouseReports.filter((data) => data.startsWith("\x1b[<")),
      focusReports: mouseReports.filter((data) => data === "\x1b[I" || data === "\x1b[O"),
      inputTimeline: [...mouseReports],
      transportReportCount,
      pointerEvents: [...pointerEvents],
      errors: [...errors],
      cols: term.cols,
      rows: term.rows,
    };
  }

  return {
    snapshot,
    pointForAlpha: () => canvasPoint(4, 3),
    // Fixed-viewport probes for default numbered-tab chrome. The runner verifies
    // the resulting authoritative workspace/tab focus, not only emitted coordinates.
    pointForNewTab: () => canvasPoint(44, 0),
    pointForTab: (number: number) => canvasPoint(38 + (number - 1) * 9, 0),
    async externalFocusRoundTrip() {
      const canvas = root.querySelector<HTMLCanvasElement>(".pane-canvas");
      const input = root.querySelector<HTMLTextAreaElement>("textarea");
      if (!canvas || !input) throw new Error("terminal focus targets are unavailable");
      const outside = document.createElement("button");
      outside.textContent = "Outside terminal";
      outside.style.cssText = "position:fixed;bottom:0;right:0";
      document.body.appendChild(outside);
      const wasDisabled = input.disabled;
      try {
        // Restty reports canvas blur. Temporarily keep focus on that real canvas
        // so the outside target produces an actual DOM blur with relatedTarget.
        input.disabled = true;
        canvas.focus({ preventScroll: true });
        if (document.activeElement !== canvas) throw new Error("canvas did not receive focus");
        outside.focus({ preventScroll: true });
        if (document.activeElement !== outside) throw new Error("external target did not receive focus");
        await inputQueue;
      } finally {
        input.disabled = wasDisabled;
        outside.remove();
      }
    },
    focusTerminal: () => term.focus(),
    async clearEvents() {
      await inputQueue;
      mouseReports.length = 0;
      pointerEvents.length = 0;
    },
    dispatchMouseRelease(point: { x: number; y: number }) {
      const canvas = root.querySelector<HTMLCanvasElement>(".pane-canvas");
      if (!canvas) throw new Error("terminal canvas is unavailable");
      canvas.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        pointerId: 17,
        pointerType: "mouse",
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: point.x,
        clientY: point.y,
      }));
    },
    claimNextTouchForKeyboard() {
      window.addEventListener("pointerup", (event) => event.preventDefault(), {
        capture: true,
        once: true,
      });
    },
    disposePointerAdapter() {
      pointerDispose?.();
      pointerDispose = undefined;
    },
  };
}

export {};
