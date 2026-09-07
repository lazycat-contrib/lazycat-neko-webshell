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
  let callbacks: { onConnect?: () => void } | undefined;
  let outputOffset = 0;
  let receivedBytes = 0;
  let inputQueue = Promise.resolve();
  let disposed = false;
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
      callbacks?.onConnect?.();
    },
    disconnect() {},
    sendInput(data: string) {
      mouseReports.push(data);
      if (mouseReports.length > 256) mouseReports.splice(0, mouseReports.length - 256);
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
      return true;
    },
    destroy() {},
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

  void pollOutput();
  countFrames();

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
    while (!disposed) {
      const response = await fetch(`/__herdr_bridge/output?offset=${outputOffset}`);
      if (!response.ok) throw new Error(`bridge output failed: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      outputOffset = Number(response.headers.get("X-Output-End") ?? outputOffset + bytes.length);
      receivedBytes += bytes.length;
      if (bytes.length) term.write(decoder.decode(bytes, { stream: true }));
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
      ready: Boolean(canvas && receivedBytes > 0 && term.restty?.getMouseStatus().active),
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
      mouseReports: [...mouseReports],
      pointerEvents: [...pointerEvents],
      errors: [...errors],
      cols: term.cols,
      rows: term.rows,
    };
  }

  return {
    snapshot,
    pointForAlpha: () => canvasPoint(4, 3),
    pointForNewTab: () => canvasPoint(44, 0),
    clearEvents() {
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
