import { Terminal } from "/node_modules/restty/dist/xterm.js";

const DATA = 1;
const DONE = 2;
const INPUT_ACK = 3;
const decoder = new TextDecoder();
const parameters = new URLSearchParams(location.search);
const paneCount = Math.max(1, Math.min(8, Number(parameters.get("panes")) || 1));
const workload = parameters.get("workload") || "small";
const continuousMs = Math.max(200, Number(parameters.get("continuousMs")) || 2000);
const nonce = parameters.get("nonce") || crypto.randomUUID();
const statusElement = document.querySelector("#status");
const resultElement = document.querySelector("#result");
const panesElement = document.querySelector("#panes");
panesElement.style.setProperty("--columns", paneCount === 1 ? "1" : "2");

const benchmark = window.__terminalBenchmark = {
  status: "booting",
  version: "restty-0.3.0",
  paneCount,
  workload,
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function twoAnimationFrames() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

async function reportResult(result) {
  await fetch("/__terminal-benchmark-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce, result }),
  });
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

class BenchmarkTransport {
  constructor(index, shared) {
    this.index = index;
    this.shared = shared;
    this.connected = deferred();
    this.completed = deferred();
    this.acknowledged = deferred();
    this.socket = null;
    this.callbacks = null;
    this.expectedSequence = 1;
    this.frameGaps = 0;
    this.receivedBytes = 0;
    this.receivedFrames = 0;
    this.pendingPaintBytes = 0;
    this.maxPendingPaintBytes = 0;
    this.paintResetScheduled = false;
    this.inputStartedAt = 0;
    this.inputDispatchMs = null;
    this.inputAckMs = null;
    this.server = null;
  }

  connect({ callbacks }) {
    this.callbacks = callbacks;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socket = new WebSocket(`${protocol}//${location.host}/benchmark-pty?pane=${this.index}`);
    socket.binaryType = "arraybuffer";
    socket.addEventListener("open", () => {
      this.shared.openSockets += 1;
      this.shared.peakSockets = Math.max(this.shared.peakSockets, this.shared.openSockets);
      callbacks.onConnect?.();
      this.connected.resolve();
    });
    socket.addEventListener("message", (event) => this.onMessage(event));
    socket.addEventListener("error", () => this.completed.reject(new Error(`pane ${this.index} websocket error`)));
    socket.addEventListener("close", () => {
      this.shared.openSockets = Math.max(0, this.shared.openSockets - 1);
      callbacks.onDisconnect?.();
    });
  }

  onMessage(event) {
    const bytes = new Uint8Array(event.data);
    const kind = bytes[0];
    if (kind === DATA) {
      const sequence = new DataView(bytes.buffer, bytes.byteOffset + 1, 4).getUint32(0);
      if (sequence !== this.expectedSequence) this.frameGaps += 1;
      this.expectedSequence = sequence + 1;
      const payload = bytes.subarray(5);
      this.receivedBytes += payload.byteLength;
      this.receivedFrames += 1;
      this.pendingPaintBytes += payload.byteLength;
      this.shared.pendingPaintBytes += payload.byteLength;
      this.maxPendingPaintBytes = Math.max(this.maxPendingPaintBytes, this.pendingPaintBytes);
      this.shared.maxPendingPaintBytes = Math.max(this.shared.maxPendingPaintBytes, this.shared.pendingPaintBytes);
      this.callbacks.onData?.(decoder.decode(payload));
      if (!this.paintResetScheduled) {
        this.paintResetScheduled = true;
        requestAnimationFrame(() => {
          this.shared.pendingPaintBytes -= this.pendingPaintBytes;
          this.pendingPaintBytes = 0;
          this.paintResetScheduled = false;
        });
      }
      return;
    }
    const payload = JSON.parse(decoder.decode(bytes.subarray(1)));
    if (kind === DONE) {
      this.server = payload;
      this.completed.resolve();
    } else if (kind === INPUT_ACK && payload.marker === `${nonce}-${this.index}`) {
      this.inputAckMs = performance.now() - this.inputStartedAt;
      this.acknowledged.resolve();
    }
  }

  disconnect() {
    this.socket?.close();
  }

  sendInput(data) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    if (data === `BENCH_INPUT:${nonce}-${this.index}`) {
      this.inputDispatchMs = performance.now() - this.inputStartedAt;
    }
    this.socket.send(data);
    this.shared.maxBrowserBufferedAmount = Math.max(
      this.shared.maxBrowserBufferedAmount,
      this.socket.bufferedAmount,
    );
    return true;
  }

  resize(cols, rows) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify({ type: "resize", cols, rows }));
    return true;
  }

  isConnected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  start() {
    this.socket.send(JSON.stringify({ type: "start", workload, continuousMs }));
  }

  markInputStart() {
    this.inputStartedAt = performance.now();
  }
}

async function createPane(index, shared) {
  const shell = document.createElement("section");
  shell.className = "pane";
  const mount = document.createElement("div");
  shell.append(mount);
  panesElement.append(shell);
  const transport = new BenchmarkTransport(index, shared);
  const term = new Terminal({
    cols: 120,
    rows: 32,
    surface: { createInitialPane: true, shortcuts: false, defaultContextMenu: false },
    terminal: {
      renderer: "webgl2",
      fonts: [{ url: "/__terminal-benchmark-font.ttf", name: "Liberation Mono" }],
      fontSize: 14,
      fontSizeMode: "em",
      ligatures: false,
      fontHinting: false,
      autoResize: true,
      showResizeOverlay: false,
      attachWindowEvents: false,
      attachCanvasEvents: false,
      maxScrollbackBytes: 8 * 1024 * 1024,
    },
    services: { ptyTransport: transport },
  });
  term.open(mount);
  const surfacePane = term.restty.getPanes()[0];
  const sizes = [];
  const states = [];
  const unsubscribe = surfacePane.runtime.events.subscribe((event) => {
    if (event.type === "term-size") sizes.push({ cols: event.cols, rows: event.rows });
    if (event.type === "state") states.push(event.state);
  });
  if (surfacePane.runtime.lifecycle.state() !== "ready") {
    await new Promise((resolve, reject) => {
      const stop = surfacePane.runtime.events.subscribe((event) => {
        if (event.type !== "state") return;
        if (event.state === "ready") { stop(); resolve(); }
        if (event.state === "failed" || event.state === "destroyed") {
          stop();
          reject(new Error(`pane ${index} runtime ${event.state}`));
        }
      });
    });
  }
  surfacePane.updateSize(true);
  surfacePane.connectPty("");
  await transport.connected.promise;
  const gl = surfacePane.canvas.getContext("webgl2");
  const debugInfo = gl?.getExtension("WEBGL_debug_renderer_info");
  return {
    term,
    transport,
    sizes,
    states,
    backend: surfacePane.getBackend(),
    webglRenderer: debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : "unavailable",
    sendMarker() {
      transport.markInputStart();
      surfacePane.sendKeyInput(`BENCH_INPUT:${nonce}-${index}`);
    },
    dispose() { unsubscribe(); term.dispose(); },
  };
}

async function run() {
  benchmark.status = "initializing";
  statusElement.textContent = `initializing ${paneCount} pane(s)`;
  const shared = {
    openSockets: 0,
    peakSockets: 0,
    pendingPaintBytes: 0,
    maxPendingPaintBytes: 0,
    maxBrowserBufferedAmount: 0,
  };
  const heapBefore = performance.memory?.usedJSHeapSize ?? null;
  const setupStarted = performance.now();
  const panes = await Promise.all(Array.from({ length: paneCount }, (_, index) => createPane(index, shared)));
  const setupMs = performance.now() - setupStarted;
  if (panes.some((pane) => pane.backend !== "webgl2")) {
    throw new Error(`expected webgl2 renderer, got ${panes.map((pane) => pane.backend).join(",")}`);
  }

  benchmark.status = "running";
  statusElement.textContent = `${workload}: ${paneCount} pane(s), webgl2`;
  const frameIntervals = [];
  let monitor = true;
  let previousFrame = performance.now();
  function monitorFrame(now) {
    frameIntervals.push(now - previousFrame);
    previousFrame = now;
    if (monitor) requestAnimationFrame(monitorFrame);
  }
  requestAnimationFrame(monitorFrame);
  const workloadStarted = performance.now();
  for (const pane of panes) pane.transport.start();

  let markerTimer;
  if (workload === "continuous") {
    markerTimer = setTimeout(() => panes.forEach((pane) => pane.sendMarker()), continuousMs / 2);
  }
  await Promise.all(panes.map((pane) => pane.transport.completed.promise));
  const receiveCompleteMs = performance.now() - workloadStarted;
  if (workload !== "continuous") panes.forEach((pane) => pane.sendMarker());
  await Promise.all(panes.map((pane) => pane.transport.acknowledged.promise));
  await twoAnimationFrames();
  const rendererSettledMs = performance.now() - workloadStarted;
  monitor = false;
  clearTimeout(markerTimer);
  await twoAnimationFrames();
  const heapAfter = performance.memory?.usedJSHeapSize ?? null;

  const result = {
    status: "complete",
    version: benchmark.version,
    paneCount,
    workload,
    rendererBackends: [...new Set(panes.map((pane) => pane.backend))],
    webglRenderers: [...new Set(panes.map((pane) => pane.webglRenderer))],
    runtimeConnectionCallbacks: paneCount,
    peakWebSocketCount: shared.peakSockets,
    setupMs,
    receiveCompleteMs,
    rendererSettledMs,
    totalOutputBytes: panes.reduce((sum, pane) => sum + pane.transport.receivedBytes, 0),
    totalOutputFrames: panes.reduce((sum, pane) => sum + pane.transport.receivedFrames, 0),
    frameGaps: panes.reduce((sum, pane) => sum + pane.transport.frameGaps, 0),
    maxBytesAwaitingPaintOpportunity: shared.maxPendingPaintBytes,
    maxServerSocketWritableBytes: Math.max(...panes.map((pane) => pane.transport.server.maxWritableBytes)),
    serverBackpressureEvents: panes.reduce((sum, pane) => sum + pane.transport.server.backpressureEvents, 0),
    maxBrowserOutgoingBufferedAmount: shared.maxBrowserBufferedAmount,
    inputDispatchMs: Math.max(...panes.map((pane) => pane.transport.inputDispatchMs ?? 0)),
    inputAckMs: Math.max(...panes.map((pane) => pane.transport.inputAckMs ?? 0)),
    animationFrameP95Ms: percentile(frameIntervals, 0.95),
    animationFrameMaxMs: Math.max(0, ...frameIntervals),
    animationFramesObserved: frameIntervals.length,
    heapDeltaBytes: heapBefore === null || heapAfter === null ? null : heapAfter - heapBefore,
    runtimeGridEvents: panes.map((pane) => pane.sizes.at(-1) ?? null),
    runtimeStates: panes.map((pane) => pane.states),
  };
  if (result.runtimeGridEvents.some((grid) => !grid || grid.cols < 20 || grid.rows < 10 || grid.rows > 200)) {
    throw new Error(`implausible runtime grid: ${JSON.stringify(result.runtimeGridEvents)}`);
  }
  Object.assign(benchmark, result);
  resultElement.textContent = JSON.stringify(result, null, 2);
  statusElement.textContent = "complete";
  await reportResult(result);
  for (const pane of panes) pane.transport.disconnect();
}

run().catch(async (error) => {
  benchmark.status = "error";
  benchmark.error = error instanceof Error ? error.stack || error.message : String(error);
  statusElement.textContent = "error";
  resultElement.textContent = benchmark.error;
  console.error(error);
  try { await reportResult({ status: "error", error: benchmark.error, paneCount, workload }); } catch {}
});
