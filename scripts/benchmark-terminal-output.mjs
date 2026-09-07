#!/usr/bin/env node

import { once } from "node:events";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { WebSocketServer } from "ws";

import { runBounded, uniqueBrowserSession } from "../tests-auto/browser-driver.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const ARTIFACT_ROOT = resolve(ROOT, "tests-auto/performance/artifacts");
const FONT_PATH = process.env.TERMINAL_BENCHMARK_FONT
  || "/usr/share/fonts/liberation/LiberationMono-Regular.ttf";
const DATA = 1;
const DONE = 2;
const INPUT_ACK = 3;
const DEFAULT_CHUNK_BYTES = 16 * 1024;
const CONTINUOUS_CHUNK_BYTES = 4 * 1024;
const CONTINUOUS_FRAME_INTERVAL_MS = 32;

function parsePositiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${label} must be a positive integer`);
  return number;
}

function parseIntegerList(value, label, allowed) {
  const values = String(value).split(",").map((item) => Number(item.trim()));
  if (!values.length || values.some((item) => !allowed.includes(item))) {
    throw new Error(`${label} must be a comma-separated subset of ${allowed.join(",")}`);
  }
  return [...new Set(values)];
}

function parseWorkloads(value) {
  const allowed = ["small", "replay", "continuous"];
  const values = String(value).split(",").map((item) => item.trim());
  if (!values.length || values.some((item) => !allowed.includes(item))) {
    throw new Error(`--workloads must be a comma-separated subset of ${allowed.join(",")}`);
  }
  return [...new Set(values)];
}

function parseArguments(argv) {
  const options = {
    repetitions: 3,
    warmups: 1,
    continuousMs: 2000,
    paneCounts: [1, 4],
    workloads: ["small", "replay", "continuous"],
    output: "",
    screenshot: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--repetitions") options.repetitions = parsePositiveInteger(argv[++index], argument);
    else if (argument === "--warmups") options.warmups = parsePositiveInteger(argv[++index], argument);
    else if (argument === "--continuous-ms") options.continuousMs = parsePositiveInteger(argv[++index], argument);
    else if (argument === "--panes") options.paneCounts = parseIntegerList(argv[++index], argument, [1, 4]);
    else if (argument === "--workloads") options.workloads = parseWorkloads(argv[++index]);
    else if (argument === "--output") options.output = resolve(argv[++index]);
    else if (argument === "--screenshot") options.screenshot = resolve(argv[++index]);
    else if (argument === "--help") {
      console.log(`Usage: node scripts/benchmark-terminal-output.mjs [options]

Options:
  --repetitions N    Recorded runs per pane/workload combination (default: 3)
  --warmups N        Discarded warm-up runs per combination (default: 1)
  --continuous-ms N  Continuous-output duration per run (default: 2000)
  --panes LIST       Comma-separated pane counts: 1,4 (default: both)
  --workloads LIST   Comma-separated small,replay,continuous (default: all)
  --output PATH      JSON artifact path
  --screenshot PATH  Final four-pane screenshot path

Environment:
  TERMINAL_BENCHMARK_FONT  Local TTF/OTF path (default: LiberationMono-Regular.ttf)`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${argument}`);
  }
  const stamp = new Date().toISOString().replaceAll(":", "-");
  options.output ||= resolve(ARTIFACT_ROOT, `terminal-output-${stamp}.json`);
  options.screenshot ||= resolve(ARTIFACT_ROOT, `terminal-output-${stamp}.png`);
  return options;
}

function outputPayload(size, sequence) {
  const line = Buffer.from(
    `\x1b[38;5;${32 + (sequence % 180)}m[${String(sequence).padStart(6, "0")}] `
      + "the quick brown fox 0123456789 terminal output\x1b[0m\r\n",
  );
  const output = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset + line.length <= size) {
    line.copy(output, offset);
    offset += line.length;
  }
  if (offset < size) output.fill(0x20, offset);
  return output;
}

function typedPayload(kind, payload) {
  const encoded = Buffer.isBuffer(payload) ? payload : Buffer.from(JSON.stringify(payload));
  return Buffer.concat([Buffer.from([kind]), encoded]);
}

function dataPayload(sequence, payload) {
  const header = Buffer.allocUnsafe(5);
  header[0] = DATA;
  header.writeUInt32BE(sequence, 1);
  return Buffer.concat([header, payload]);
}

async function writeSocketFrame(connection, payload) {
  if (connection.socket.readyState !== 1) {
    throw new Error("benchmark websocket closed during output");
  }
  await new Promise((resolveSend, rejectSend) => {
    connection.socket.send(payload, { binary: true }, (error) => {
      if (error) rejectSend(error);
      else resolveSend();
    });
    connection.maxWritableBytes = Math.max(connection.maxWritableBytes, connection.socket.bufferedAmount);
    if (connection.socket.bufferedAmount > 256 * 1024) connection.backpressureEvents += 1;
  });
}

async function streamWorkload(connection, request) {
  if (connection.started) return;
  connection.started = true;
  const started = performance.now();
  let totalBytes;
  let chunkBytes;
  let frameCount;
  if (request.workload === "small") {
    totalBytes = 16 * 1024;
    chunkBytes = 4 * 1024;
    frameCount = totalBytes / chunkBytes;
  } else if (request.workload === "replay") {
    totalBytes = 350 * 1024;
    chunkBytes = DEFAULT_CHUNK_BYTES;
    frameCount = Math.ceil(totalBytes / chunkBytes);
  } else if (request.workload === "continuous") {
    chunkBytes = CONTINUOUS_CHUNK_BYTES;
    frameCount = Math.max(1, Math.ceil(request.continuousMs / CONTINUOUS_FRAME_INTERVAL_MS));
    totalBytes = frameCount * chunkBytes;
  } else {
    throw new Error(`unknown workload: ${request.workload}`);
  }

  let sentBytes = 0;
  for (let sequence = 1; sequence <= frameCount; sequence += 1) {
    const remaining = totalBytes - sentBytes;
    const payload = outputPayload(Math.min(chunkBytes, remaining), sequence);
    await writeSocketFrame(connection, dataPayload(sequence, payload));
    sentBytes += payload.length;
    if (request.workload === "continuous") {
      const due = started + sequence * CONTINUOUS_FRAME_INTERVAL_MS;
      const delay = Math.max(0, due - performance.now());
      if (delay > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
  await writeSocketFrame(connection, typedPayload(DONE, {
    outputBytes: sentBytes,
    outputFrames: frameCount,
    maxWritableBytes: connection.maxWritableBytes,
    backpressureEvents: connection.backpressureEvents,
    serverElapsedMs: performance.now() - started,
  }));
}

function acceptBenchmarkSocket(socket, openSockets) {
  const connection = {
    socket,
    started: false,
    maxWritableBytes: 0,
    backpressureEvents: 0,
  };
  openSockets.add(socket);
  socket.on("close", () => openSockets.delete(socket));
  socket.on("error", () => openSockets.delete(socket));
  socket.on("message", (payload, isBinary) => {
    try {
      if (isBinary) return;
      const text = payload.toString("utf8");
      const markerMatch = text.match(/BENCH_INPUT:([A-Za-z0-9-]+)/);
      if (markerMatch) {
        const marker = markerMatch[1];
        if (process.env.TERMINAL_BENCHMARK_DEBUG) process.stderr.write(`INPUT ${JSON.stringify(text)}\n`);
        void writeSocketFrame(connection, typedPayload(INPUT_ACK, { marker }));
        return;
      }
      const message = JSON.parse(text);
      if (message.type === "start") {
        void streamWorkload(connection, message).catch(() => socket.terminate());
      }
    } catch {
      socket.terminate();
    }
  });
}

async function startFixture(font) {
  const openSockets = new Set();
  const results = new Map();
  const resultWaiters = new Map();
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const server = createHttpServer((request, response) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (process.env.TERMINAL_BENCHMARK_DEBUG) process.stderr.write(`HTTP ${pathname}\n`);
    if (pathname === "/__terminal-benchmark-result" && request.method === "POST") {
      const chunks = [];
      let size = 0;
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy();
        else chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (typeof message.nonce !== "string" || !message.result) throw new Error("invalid result");
          const waiter = resultWaiters.get(message.nonce);
          if (waiter) {
            waiter(message.result);
            resultWaiters.delete(message.nonce);
          } else {
            results.set(message.nonce, message.result);
          }
          response.writeHead(204).end();
        } catch {
          response.writeHead(400).end("invalid benchmark result");
        }
      });
      return;
    }
    if (pathname === "/__terminal-benchmark-font.ttf") {
      response.writeHead(200, { "content-type": "font/ttf", "cache-control": "public, max-age=3600" });
      response.end(font);
      return;
    }
    const allowed = pathname.startsWith("/tests-auto/performance/")
      || pathname.startsWith("/node_modules/restty/dist/");
    if (!allowed || pathname.includes("..")) {
      response.writeHead(404).end("not found");
      return;
    }
    const file = resolve(ROOT, pathname.slice(1));
    void readFile(file).then((body) => {
      const contentType = pathname.endsWith(".html")
        ? "text/html; charset=utf-8"
        : pathname.endsWith(".js") || pathname.endsWith(".mjs")
          ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    }).catch(() => response.writeHead(404).end("not found"));
  });
  server.on("upgrade", (request, socket, head) => {
    if (process.env.TERMINAL_BENCHMARK_DEBUG) process.stderr.write(`WS ${request.url}\n`);
    if (new URL(request.url, "http://localhost").pathname !== "/benchmark-pty") {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (websocket) => {
      acceptBenchmarkSocket(websocket, openSockets);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    result(nonce, deadlineMs = 90_000) {
      if (results.has(nonce)) {
        const result = results.get(nonce);
        results.delete(nonce);
        return Promise.resolve(result);
      }
      return new Promise((resolveResult, rejectResult) => {
        const timer = setTimeout(() => {
          resultWaiters.delete(nonce);
          rejectResult(new Error(`timed out waiting for browser benchmark result: ${nonce}`));
        }, deadlineMs);
        resultWaiters.set(nonce, (result) => {
          clearTimeout(timer);
          resolveResult(result);
        });
      });
    },
    async close() {
      for (const socket of openSockets) socket.terminate();
      sockets.close();
      server.close();
      await once(server, "close");
    },
  };
}

async function browserCommand(session, argumentsList) {
  return runBounded("agent-browser", ["--session", session, ...argumentsList], {
    cwd: ROOT,
    timeoutMs: 30_000,
    maxOutputBytes: 512 * 1024,
  });
}

function agentBrowserSession() {
  return uniqueBrowserSession("terminal-output");
}

function quantile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)];
}

function aggregateRuns(runs, paneCounts, workloads) {
  const scalarMetrics = [
    "setupMs",
    "receiveCompleteMs",
    "rendererSettledMs",
    "totalOutputBytes",
    "totalOutputFrames",
    "frameGaps",
    "runtimeConnectionCallbacks",
    "peakWebSocketCount",
    "maxBytesAwaitingPaintOpportunity",
    "maxServerSocketWritableBytes",
    "serverBackpressureEvents",
    "maxBrowserOutgoingBufferedAmount",
    "inputDispatchMs",
    "inputAckMs",
    "animationFrameP95Ms",
    "animationFrameMaxMs",
    "heapDeltaBytes",
  ];
  const summaries = [];
  for (const paneCount of paneCounts) {
    for (const workload of workloads) {
      const selected = runs.filter((run) => run.paneCount === paneCount && run.workload === workload);
      const metrics = {};
      for (const metric of scalarMetrics) {
        const values = selected.map((run) => run[metric]).filter(Number.isFinite);
        metrics[metric] = values.length ? {
          median: quantile(values, 0.5),
          p95: quantile(values, 0.95),
          max: Math.max(...values),
        } : null;
      }
      summaries.push({ paneCount, workload, runs: selected.length, metrics });
    }
  }
  return summaries;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  await mkdir(resolve(options.output, ".."), { recursive: true });
  await mkdir(resolve(options.screenshot, ".."), { recursive: true });
  const session = agentBrowserSession();
  const rawRuns = [];
  const coldRuns = [];
  const screenshot = { path: options.screenshot, captured: false, error: null };
  const chromeArguments = [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--enable-precise-memory-info",
  ].join(",");
  const environment = {
    node: process.version,
    agentBrowser: "unavailable",
    restty: "0.3.0",
    rendererRequested: "webgl2",
    browserMode: "headed Xvfb",
    chromeArguments,
    fontPath: FONT_PATH,
    fixture: "isolated loopback static server + WebSocket",
    continuousMs: options.continuousMs,
    repetitions: options.repetitions,
    warmups: options.warmups,
  };
  let fixture;
  let browserOpened = false;
  let currentScenario = null;
  let operationError;
  const cleanupErrors = [];
  try {
    environment.agentBrowser = await runBounded("agent-browser", ["--version"], {
      cwd: ROOT,
      timeoutMs: 5_000,
      maxOutputBytes: 16 * 1024,
    });
    const font = await readFile(FONT_PATH);
    fixture = await startFixture(font);
    await browserCommand(session, ["--headed", "--args", chromeArguments, "open", "about:blank"]);
    browserOpened = true;
    await browserCommand(session, ["set", "viewport", "1280", "900"]);
    for (const paneCount of options.paneCounts) {
      for (const workload of options.workloads) {
        const totalRuns = options.warmups + options.repetitions;
        for (let iteration = 0; iteration < totalRuns; iteration += 1) {
          currentScenario = { paneCount, workload, iteration, totalRuns };
          const url = new URL("/tests-auto/performance/terminal-output.html", fixture.origin);
          url.searchParams.set("panes", String(paneCount));
          url.searchParams.set("workload", workload);
          url.searchParams.set("continuousMs", String(options.continuousMs));
          const nonce = `${paneCount}-${workload}-${iteration}-${Date.now()}`;
          url.searchParams.set("nonce", nonce);
          await browserCommand(session, ["open", url.toString()]);
          const result = await fixture.result(nonce);
          if (result.status !== "complete") throw new Error(result.error || "browser benchmark failed");
          if (iteration >= options.warmups) rawRuns.push({ ...result, iteration: iteration - options.warmups });
          else coldRuns.push({ ...result, warmupIteration: iteration });
          process.stdout.write(`${paneCount} pane(s) ${workload} run ${iteration + 1}/${totalRuns}: ${result.rendererSettledMs.toFixed(1)} ms\n`);
          if (!screenshot.captured && paneCount === 4 && workload === "small" && iteration >= options.warmups) {
            try {
              await browserCommand(session, ["screenshot", options.screenshot]);
              screenshot.captured = true;
            } catch (error) {
              screenshot.error = error instanceof Error ? error.message : String(error);
            }
          }
        }
      }
    }
    if (!screenshot.captured) {
      try {
        await browserCommand(session, ["screenshot", options.screenshot]);
        screenshot.captured = true;
      } catch (error) {
        screenshot.error = error instanceof Error ? error.message : String(error);
      }
    }
    currentScenario = null;
  } catch (error) {
    operationError = error;
    const message = error instanceof Error ? error.stack || error.message : String(error);
    await writeFile(options.output, `${JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      recordedAt: new Date().toISOString(),
      environment,
      currentScenario,
      error: message,
      coldRuns,
      rawRuns,
      screenshot,
    }, null, 2)}\n`);
  } finally {
    if (browserOpened) {
      try { await browserCommand(session, ["close"]); }
      catch (error) { cleanupErrors.push(error); }
    }
    if (fixture) {
      try { await fixture.close(); }
      catch (error) { cleanupErrors.push(error); }
    }
  }
  if (operationError) {
    if (cleanupErrors.length && operationError instanceof Error) {
      operationError.message += `\nCleanup errors: ${cleanupErrors.map(String).join("; ")}`;
    }
    throw operationError;
  }
  if (cleanupErrors.length) {
    const error = new Error(`benchmark cleanup failed: ${cleanupErrors.map(String).join("; ")}`);
    await writeFile(options.output, `${JSON.stringify({
      schemaVersion: 1,
      status: "failed",
      recordedAt: new Date().toISOString(),
      environment,
      currentScenario: null,
      error: error.message,
      coldRuns,
      rawRuns,
      screenshot,
    }, null, 2)}\n`);
    throw error;
  }

  const summaries = aggregateRuns(rawRuns, options.paneCounts, options.workloads);
  const replayAndContinuous = summaries.filter((summary) => summary.workload !== "small");
  const observedRisk = replayAndContinuous.some((summary) => (
    summary.metrics.frameGaps.max > 0
    || summary.metrics.inputAckMs.p95 > 250
    || summary.metrics.serverBackpressureEvents.max > 0
    || summary.metrics.maxServerSocketWritableBytes.max > 1024 * 1024
  ));
  const artifact = {
    schemaVersion: 1,
    status: "complete",
    recordedAt: new Date().toISOString(),
    environment,
    summaries,
    coldRuns,
    screenshot,
    rawRuns,
    decision: {
      rendererLayer: observedRisk
        ? "renderer measurements warrant further bounded-drain investigation before changing protocol"
        : "retain separate per-pane sockets; do not add consumption ACK from renderer-only evidence",
      productionTransport: "undetermined until the same workload runs through real LightOS, provider sockets, and PTYs",
      consumptionAckAdded: false,
      observedRisk,
    },
    limitations: [
      "Loopback WebSockets measure browser decode, Restty parsing/render scheduling, and local socket backpressure; they do not measure LightOS, provider, remote PTY, or WAN queues.",
      "rendererSettledMs waits for final receive and all input marker acknowledgments, then two animation frames; it is not a pure render duration or renderer consumption acknowledgment.",
      "maxBytesAwaitingPaintOpportunity is harness-visible data delivered since the previous animation frame, not Restty internal queue memory.",
    ],
  };
  await writeFile(options.output, `${JSON.stringify(artifact, null, 2)}\n`);
  console.table(summaries.map((summary) => ({
    panes: summary.paneCount,
    workload: summary.workload,
    outputKiB: (summary.metrics.totalOutputBytes.median / 1024).toFixed(1),
    receiveMs: summary.metrics.receiveCompleteMs.median.toFixed(1),
    settleMs: summary.metrics.rendererSettledMs.median.toFixed(1),
    inputAckMs: summary.metrics.inputAckMs.p95.toFixed(1),
    maxPendingKiB: (summary.metrics.maxBytesAwaitingPaintOpportunity.max / 1024).toFixed(1),
    gaps: summary.metrics.frameGaps.max,
    sockets: summary.metrics.peakWebSocketCount.median,
  })));
  console.log(`artifact: ${options.output}`);
  console.log(`screenshot: ${options.screenshot}`);
}

await main();
