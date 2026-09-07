import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { constants as fsConstants, createReadStream } from "node:fs";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer as createViteServer } from "vite";

import {
  createBrowserDriver,
  runBounded,
  uniqueBrowserSession,
} from "../browser-driver.mjs";

const scenarioRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scenarioRoot, "../..");
const artifactRoot = join(repositoryRoot, "tests-auto", "artifacts", "herdr-pointer");
const BROWSER_ARGS = "--use-gl=angle,--use-angle=swiftshader,--enable-unsafe-swiftshader";

export async function runHerdrPointerScenario() {
  const startedAt = Date.now();
  const artifactDirectory = join(
    artifactRoot,
    `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
  );
  await mkdir(artifactDirectory, { recursive: true });
  const stateDirectory = await mkdtemp(join(tmpdir(), "neko-webshell-herdr-pointer-"));
  const metrics = {
    scenario: "herdr-pointer",
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    prerequisites: {},
    phases: {},
  };
  const cleanupErrors = [];
  let bridge;
  let vite;
  let browser;
  let primaryError;

  try {
    const herdrBinary = await findExecutable(
      process.env.HERDR_TEST_BINARY,
      "herdr",
    );
    const pythonBinary = await findExecutable(process.env.PYTHON, "python3");
    const fontPath = await findFont(process.env.HERDR_TEST_FONT);
    const herdrVersion = await runBounded(herdrBinary, ["--version"], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    if (!/\bherdr 0\.8\.2\b/.test(herdrVersion)) {
      throw new Error(`Herdr 0.8.2 is required; found ${herdrVersion || "unknown"}`);
    }
    const browserVersion = await runBounded("agent-browser", ["--version"], {
      timeoutMs: 5_000,
      maxOutputBytes: 64 * 1024,
    });
    metrics.prerequisites = {
      herdrVersion,
      browserVersion,
      font: basename(fontPath),
      rendererPackage: "restty@0.3.0",
    };

    bridge = await startBridge({ pythonBinary, herdrBinary, stateDirectory });
    const herdrEnvironment = isolatedHerdrEnvironment(bridge.ready);
    await waitForHerdr(herdrBinary, herdrEnvironment, stateDirectory);
    const alpha = workspaceId(
      await herdrJson(
        herdrBinary,
        ["workspace", "create", "--label", "alpha", "--no-focus"],
        herdrEnvironment,
        stateDirectory,
      ),
    );
    const beta = workspaceId(
      await herdrJson(
        herdrBinary,
        ["workspace", "create", "--label", "beta", "--focus"],
        herdrEnvironment,
        stateDirectory,
      ),
    );
    await waitForWorkspaceFocus(herdrBinary, herdrEnvironment, stateDirectory, beta);
    metrics.phases.isolation = { alpha, beta, bridgePort: bridge.ready.port };

    vite = await startFixtureServer(bridge.ready.port, fontPath);
    const baselineUrl = `${vite.url}/tests-auto/herdr-pointer/fixture.html`;
    browser = createBrowserDriver({
      session: uniqueBrowserSession("herdr-pointer"),
      headed: true,
      launchArgs: BROWSER_ARGS,
      commandTimeoutMs: 20_000,
    });
    await browser.open(`${baselineUrl}?adapter=0`);
    await browser.waitFor(
      "window.__herdrProbe?.snapshot().ready === true && window.__herdrProbe.snapshot().rendererBackend !== 'unknown'",
      { timeoutMs: 20_000 },
    );

    const initialFrame = await probeSnapshot(browser);
    assertFrameEvidence(initialFrame);
    const alphaPoint = await browser.evaluate("window.__herdrProbe.pointForAlpha()");
    await clearProbe(browser);
    await touchTap(browser, alphaPoint);
    await browser.waitFor("window.__herdrProbe.snapshot().mouseReports.length >= 1");
    const baselineReports = (await probeSnapshot(browser)).mouseReports;
    const baselineDown = assertSinglePressWithoutRelease(baselineReports, "Restty baseline touch");
    assert.equal(
      await focusedWorkspace(herdrBinary, herdrEnvironment, stateDirectory),
      beta,
      "baseline touch must leave beta focused without a release",
    );
    await captureScreenshot(browser, join(artifactDirectory, "baseline-down-only.png"));

    const releaseStartedAt = Date.now();
    await browser.evaluate(
      `window.__herdrProbe.dispatchMouseRelease(${JSON.stringify(alphaPoint)})`,
    );
    await waitForWorkspaceFocus(herdrBinary, herdrEnvironment, stateDirectory, alpha);
    metrics.phases.baseline = {
      expectedDefect: "touch emits SGR press without release",
      report: escapeReport(baselineReports[0]),
      cell: { column: baselineDown.column, row: baselineDown.row },
      manualReleaseFocusMs: Date.now() - releaseStartedAt,
    };

    await focusWorkspace(herdrBinary, herdrEnvironment, stateDirectory, beta);
    await browser.navigate(`${baselineUrl}?adapter=1`);
    await browser.waitFor(
      "window.__herdrProbe?.snapshot().ready === true && window.__herdrProbe.snapshot().rendererBackend !== 'unknown'",
      { timeoutMs: 20_000 },
    );
    const adapterPoint = await browser.evaluate("window.__herdrProbe.pointForAlpha()");
    await clearProbe(browser);
    await touchTap(browser, adapterPoint);
    await browser.waitFor("window.__herdrProbe.snapshot().mouseReports.length >= 2");
    const adapterReports = (await probeSnapshot(browser)).mouseReports;
    const adapterPair = assertClickPair(adapterReports, "adapter touch");
    await waitForWorkspaceFocus(herdrBinary, herdrEnvironment, stateDirectory, alpha);
    await captureScreenshot(browser, join(artifactDirectory, "adapter-selection.png"));
    metrics.phases.adapterSelection = {
      reports: adapterReports.map(escapeReport),
      cell: { column: adapterPair.press.column, row: adapterPair.press.row },
    };

    await focusWorkspace(herdrBinary, herdrEnvironment, stateDirectory, beta);
    await clearProbe(browser);
    await browser.dispatchMouse([
      {
        type: "mousePressed",
        x: adapterPoint.x,
        y: adapterPoint.y,
        button: "left",
        buttons: 1,
        clickCount: 1,
      },
      {
        type: "mouseReleased",
        x: adapterPoint.x,
        y: adapterPoint.y,
        button: "left",
        buttons: 0,
        clickCount: 1,
      },
    ]);
    await browser.waitFor("window.__herdrProbe.snapshot().mouseReports.length >= 2");
    const nativeMouseReports = (await probeSnapshot(browser)).mouseReports;
    assertClickPair(nativeMouseReports, "native mouse");
    await waitForWorkspaceFocus(herdrBinary, herdrEnvironment, stateDirectory, alpha);
    metrics.phases.nativeMouse = { reports: nativeMouseReports.map(escapeReport) };

    await focusWorkspace(herdrBinary, herdrEnvironment, stateDirectory, beta);
    await clearProbe(browser);
    await touchDrag(browser, adapterPoint, { x: adapterPoint.x, y: adapterPoint.y + 30 });
    await delay(150);
    const scrollReports = (await probeSnapshot(browser)).mouseReports;
    assert.equal(
      scrollReports.map(parseSgrMouse).filter((report) => report?.button === 0).length,
      0,
      "touch scroll must not emit a primary-button click",
    );
    assert.equal(
      await focusedWorkspace(herdrBinary, herdrEnvironment, stateDirectory),
      beta,
      "touch scroll must not focus alpha",
    );
    metrics.phases.scroll = { reports: scrollReports.map(escapeReport) };

    await clearProbe(browser);
    await browser.dispatchTouch([
      touchEvent("touchStart", adapterPoint, 21),
      { type: "touchCancel", touchPoints: [] },
    ]);
    await delay(100);
    const cancelReports = (await probeSnapshot(browser)).mouseReports;
    assert.equal(cancelReports.length, 0, "cancelled touch must not emit terminal input");
    assert.equal(await focusedWorkspace(herdrBinary, herdrEnvironment, stateDirectory), beta);
    metrics.phases.cancel = { reports: [] };

    await clearProbe(browser);
    await browser.evaluate("window.__herdrProbe.claimNextTouchForKeyboard()");
    await touchTap(browser, adapterPoint, 22);
    await delay(100);
    const keyboardClaimReports = (await probeSnapshot(browser)).mouseReports;
    assert.equal(keyboardClaimReports.length, 0, "keyboard-claimed touch must not emit terminal input");
    assert.equal(await focusedWorkspace(herdrBinary, herdrEnvironment, stateDirectory), beta);
    metrics.phases.keyboardClaim = { reports: [] };

    await focusWorkspace(herdrBinary, herdrEnvironment, stateDirectory, alpha);
    const tabsBefore = await tabCount(herdrBinary, herdrEnvironment, stateDirectory, alpha);
    const plusPoint = await browser.evaluate("window.__herdrProbe.pointForNewTab()");
    await clearProbe(browser);
    await touchTap(browser, plusPoint, 23);
    await browser.waitFor("window.__herdrProbe.snapshot().mouseReports.length >= 2");
    const escapePromptReports = (await probeSnapshot(browser)).mouseReports;
    assertClickPair(escapePromptReports, "new-tab prompt touch");
    await captureScreenshot(browser, join(artifactDirectory, "new-tab-prompt.png"));
    await browser.press("Escape");
    await delay(100);
    await browser.press("Enter");
    await delay(150);
    assert.equal(
      await tabCount(herdrBinary, herdrEnvironment, stateDirectory, alpha),
      tabsBefore,
      "Escape must close the native new-tab prompt",
    );

    await clearProbe(browser);
    await touchTap(browser, plusPoint, 24);
    await browser.waitFor("window.__herdrProbe.snapshot().mouseReports.length >= 2");
    await browser.press("Enter");
    await waitForTabCount(
      herdrBinary,
      herdrEnvironment,
      stateDirectory,
      alpha,
      tabsBefore + 1,
    );
    metrics.phases.newTabPrompt = {
      escapePreservedTabCount: tabsBefore,
      acceptedTabCount: tabsBefore + 1,
    };

    await focusWorkspace(herdrBinary, herdrEnvironment, stateDirectory, beta);
    await clearProbe(browser);
    await browser.evaluate("window.__herdrProbe.disposePointerAdapter()");
    await touchTap(browser, adapterPoint, 25);
    await browser.waitFor("window.__herdrProbe.snapshot().mouseReports.length >= 1");
    const disposeReports = (await probeSnapshot(browser)).mouseReports;
    assertSinglePressWithoutRelease(disposeReports, "disposed adapter touch");
    assert.equal(await focusedWorkspace(herdrBinary, herdrEnvironment, stateDirectory), beta);
    metrics.phases.dispose = {
      expectedNativeFallback: "one Restty SGR press and no synthesized release",
      reports: disposeReports.map(escapeReport),
    };

    const finalFrame = await probeSnapshot(browser);
    assertFrameEvidence(finalFrame);
    assert.deepEqual(finalFrame.errors, [], "browser fixture reported runtime errors");
    metrics.frameEvidence = {
      rendererBackend: finalFrame.rendererBackend,
      receivedBytes: finalFrame.receivedBytes,
      animationFrames: finalFrame.animationFrames,
      canvas: finalFrame.canvas,
      cols: finalFrame.cols,
      rows: finalFrame.rows,
    };
    metrics.status = "passed";
  } catch (error) {
    primaryError = error;
    metrics.status = "failed";
    metrics.error = error instanceof Error ? error.message : String(error);
    if (browser) {
      try {
        metrics.failureProbe = await probeSnapshot(browser);
      } catch (captureError) {
        cleanupErrors.push(`failure probe: ${errorMessage(captureError)}`);
      }
      try {
        metrics.browserErrors = await browser.command(["--json", "errors"]);
        metrics.browserConsole = await browser.command(["--json", "console"]);
      } catch (captureError) {
        cleanupErrors.push(`browser diagnostics: ${errorMessage(captureError)}`);
      }
      try {
        await browser.screenshot(join(artifactDirectory, "failure.png"));
      } catch (captureError) {
        cleanupErrors.push(`failure screenshot: ${errorMessage(captureError)}`);
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (error) {
        cleanupErrors.push(`browser close: ${errorMessage(error)}`);
      }
    }
    if (vite) {
      try {
        await vite.close();
      } catch (error) {
        cleanupErrors.push(`Vite close: ${errorMessage(error)}`);
      }
    }
    if (bridge) {
      try {
        await stopBridge(bridge);
      } catch (error) {
        cleanupErrors.push(`bridge close: ${errorMessage(error)}`);
      }
    }
    try {
      assertOwnedTemporaryDirectory(stateDirectory);
      await rm(stateDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(`temporary state cleanup: ${errorMessage(error)}`);
    }
    metrics.cleanupErrors = cleanupErrors;
    metrics.elapsedMs = Date.now() - startedAt;
    await writeFile(
      join(artifactDirectory, "errors.json"),
      `${JSON.stringify(
        {
          scenarioError: metrics.error ?? null,
          browserErrors: metrics.browserErrors ?? null,
          fixtureErrors: metrics.failureProbe?.errors ?? [],
          cleanupErrors,
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(artifactDirectory, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`);
  }

  if (primaryError) {
    if (cleanupErrors.length) primaryError.message += `\nCleanup errors:\n${cleanupErrors.join("\n")}`;
    throw primaryError;
  }
  if (cleanupErrors.length) throw new Error(`Herdr pointer cleanup failed:\n${cleanupErrors.join("\n")}`);
  return { scenario: "herdr-pointer", status: "passed", artifactDirectory };
}

async function startBridge({ pythonBinary, herdrBinary, stateDirectory }) {
  const childEnvironment = controlledBaseEnvironment();
  const child = spawn(
    pythonBinary,
    [join(scenarioRoot, "bridge.py"), herdrBinary, stateDirectory],
    {
      cwd: stateDirectory,
      env: childEnvironment,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  let ready;
  try {
    ready = await new Promise((resolveReady, rejectReady) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectReady(new Error(`Herdr bridge startup timed out; stderr=${stderr}`));
      }, 10_000);
      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectReady(error);
      };
      child.on("error", fail);
      child.on("exit", (code, signal) => {
        fail(new Error(`Herdr bridge exited before ready: code=${code} signal=${signal}; stderr=${stderr}`));
      });
      child.stderr.on("data", (chunk) => {
        stderr = appendBounded(stderr, chunk, 256 * 1024);
      });
      child.stdout.on("data", (chunk) => {
        stdout = appendBounded(stdout, chunk, 64 * 1024);
        const newline = stdout.indexOf("\n");
        if (newline < 0 || settled) return;
        try {
          const value = JSON.parse(stdout.slice(0, newline));
          if (
            value.type !== "ready" ||
            !Number.isInteger(value.port) ||
            !Number.isInteger(value.herdrPid)
          ) {
            throw new Error("invalid Herdr bridge ready message");
          }
          settled = true;
          clearTimeout(timer);
          resolveReady(value);
        } catch (error) {
          fail(error);
        }
      });
    });
  } catch (error) {
    signalOwnedGroup(child.pid, "SIGTERM");
    if (!(await waitForExit(child, 4_000))) {
      signalOwnedGroup(child.pid, "SIGKILL");
      await waitForExit(child, 2_000);
    }
    throw error;
  }
  return { child, ready, stderr: () => stderr, stopped: false };
}

async function stopBridge(bridge) {
  if (bridge.stopped) return;
  bridge.stopped = true;
  signalOwnedGroup(bridge.child.pid, "SIGTERM");
  if (!(await waitForExit(bridge.child, 4_000))) {
    signalOwnedGroup(bridge.child.pid, "SIGKILL");
    await waitForExit(bridge.child, 2_000);
  }
  if (groupExists(bridge.ready.herdrPid)) {
    signalOwnedGroup(bridge.ready.herdrPid, "SIGTERM");
    await delay(250);
    if (groupExists(bridge.ready.herdrPid)) signalOwnedGroup(bridge.ready.herdrPid, "SIGKILL");
  }
  if (bridge.child.exitCode === null && bridge.child.signalCode === null) {
    throw new Error(`bridge process ${bridge.child.pid} did not exit; stderr=${bridge.stderr()}`);
  }
}

async function startFixtureServer(bridgePort, fontPath) {
  const vite = await createViteServer({
    configFile: false,
    root: repositoryRoot,
    appType: "spa",
    logLevel: "error",
    plugins: [
      {
        name: "herdr-pointer-font",
        configureServer(viteServer) {
          viteServer.middlewares.use("/__herdr_font", (_request, response) => {
            response.setHeader("Content-Type", "font/ttf");
            const stream = createReadStream(fontPath);
            stream.on("error", (error) => response.destroy(error));
            stream.pipe(response);
          });
        },
      },
    ],
    server: {
      middlewareMode: true,
      proxy: {
        "/__herdr_bridge": {
          target: `http://127.0.0.1:${bridgePort}`,
          rewrite: (path) => path.replace(/^\/__herdr_bridge/, ""),
        },
      },
    },
  });
  const http = createHttpServer(vite.middlewares);
  http.requestTimeout = 5_000;
  http.headersTimeout = 5_000;
  http.keepAliveTimeout = 1_000;
  try {
    await new Promise((resolveListen, rejectListen) => {
      http.once("error", rejectListen);
      http.listen(0, "127.0.0.1", () => {
        http.off("error", rejectListen);
        resolveListen();
      });
    });
  } catch (error) {
    await vite.close();
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") {
    http.closeAllConnections();
    await vite.close();
    throw new Error("HTTP server omitted its TCP port");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      let closeError;
      try {
        await new Promise((resolveClose, rejectClose) => {
          http.close((error) => (error ? rejectClose(error) : resolveClose()));
        });
      } catch (error) {
        closeError = error;
      }
      try {
        await vite.close();
      } catch (error) {
        if (!closeError) closeError = error;
        else closeError.message += `\nVite close failed: ${error.message}`;
      }
      if (closeError) throw closeError;
    },
  };
}

async function waitForHerdr(binary, environment, cwd) {
  const deadline = Date.now() + 10_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await herdrJson(binary, ["workspace", "list"], environment, cwd);
      return;
    } catch (error) {
      lastError = error;
      await delay(100);
    }
  }
  throw new Error(`isolated Herdr socket did not become ready: ${errorMessage(lastError)}`);
}

async function herdrJson(binary, args, environment, cwd) {
  const output = await runBounded(binary, args, {
    cwd,
    env: environment,
    inheritEnv: false,
    timeoutMs: 5_000,
    maxOutputBytes: 1024 * 1024,
  });
  try {
    return JSON.parse(output);
  } catch (error) {
    throw new Error(`Herdr returned invalid JSON for ${args.join(" ")}: ${error.message}`);
  }
}

function isolatedHerdrEnvironment(ready) {
  return {
    ...controlledBaseEnvironment(),
    HERDR_CONFIG_PATH: ready.configPath,
    HERDR_SOCKET_PATH: ready.socketPath,
    XDG_CONFIG_HOME: ready.xdgPath,
  };
}

function controlledBaseEnvironment() {
  const environment = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TERM: "xterm-256color",
    SHELL: "/bin/sh",
  };
  for (const key of ["HOME", "USER", "LOGNAME", "LANG", "LC_ALL"]) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function workspaceId(response) {
  const id = response?.result?.workspace?.workspace_id ?? response?.workspace?.workspace_id;
  if (typeof id !== "string" || !id) throw new Error("Herdr workspace create omitted workspace_id");
  return id;
}

async function focusedWorkspace(binary, environment, cwd) {
  const response = await herdrJson(binary, ["workspace", "list"], environment, cwd);
  const result = response?.result ?? response;
  for (const key of [
    "focused_workspace_id",
    "active_workspace_id",
    "selected_workspace_id",
    "current_workspace_id",
  ]) {
    if (typeof result?.[key] === "string") return result[key];
  }
  const workspaces = result?.workspaces;
  if (Array.isArray(workspaces)) {
    const focused = workspaces.find(
      (workspace) => workspace.focused === true || workspace.active === true || workspace.is_focused === true,
    );
    if (typeof focused?.workspace_id === "string") return focused.workspace_id;
  }
  throw new Error(`Herdr workspace list omitted focused workspace: ${JSON.stringify(response)}`);
}

async function focusWorkspace(binary, environment, cwd, workspace) {
  await herdrJson(binary, ["workspace", "focus", workspace], environment, cwd);
  await waitForWorkspaceFocus(binary, environment, cwd, workspace);
}

async function waitForWorkspaceFocus(binary, environment, cwd, expected) {
  const deadline = Date.now() + 3_000;
  let actual;
  while (Date.now() < deadline) {
    actual = await focusedWorkspace(binary, environment, cwd);
    if (actual === expected) return;
    await delay(50);
  }
  throw new Error(`workspace focus timed out: expected=${expected} actual=${actual}`);
}

async function tabCount(binary, environment, cwd, workspace) {
  const response = await herdrJson(
    binary,
    ["tab", "list", "--workspace", workspace],
    environment,
    cwd,
  );
  const tabs = (response?.result ?? response)?.tabs;
  if (!Array.isArray(tabs)) throw new Error(`Herdr tab list omitted tabs: ${JSON.stringify(response)}`);
  return tabs.length;
}

async function waitForTabCount(binary, environment, cwd, workspace, expected) {
  const deadline = Date.now() + 3_000;
  let actual;
  while (Date.now() < deadline) {
    actual = await tabCount(binary, environment, cwd, workspace);
    if (actual === expected) return;
    await delay(50);
  }
  throw new Error(`tab count timed out: expected=${expected} actual=${actual}`);
}

async function probeSnapshot(browser) {
  const value = await browser.evaluate("window.__herdrProbe?.snapshot()");
  if (!value || typeof value !== "object") throw new Error("browser probe snapshot is unavailable");
  return value;
}

async function clearProbe(browser) {
  await browser.evaluate("window.__herdrProbe.clearEvents()");
}

async function touchTap(browser, point, id = 17) {
  await browser.dispatchTouch([
    { ...touchEvent("touchStart", point, id), delayMs: 30 },
    { type: "touchEnd", touchPoints: [] },
  ]);
}

async function touchDrag(browser, start, end, id = 19) {
  await browser.dispatchTouch([
    { ...touchEvent("touchStart", start, id), delayMs: 20 },
    { ...touchEvent("touchMove", end, id), delayMs: 20 },
    { type: "touchEnd", touchPoints: [] },
  ]);
}

function touchEvent(type, point, id) {
  return {
    type,
    touchPoints: [{ x: point.x, y: point.y, id, radiusX: 1, radiusY: 1, force: 1 }],
  };
}

function assertSinglePressWithoutRelease(reports, label) {
  assert.equal(reports.length, 1, `${label} must emit exactly one report`);
  const parsed = parseSgrMouse(reports[0]);
  assert.ok(parsed, `${label} must emit an SGR mouse report`);
  assert.equal(parsed.button, 0, `${label} must use the primary button`);
  assert.equal(parsed.final, "M", `${label} must emit only the press`);
  return parsed;
}

function assertClickPair(reports, label) {
  assert.equal(reports.length, 2, `${label} must emit exactly press and release`);
  const press = parseSgrMouse(reports[0]);
  const release = parseSgrMouse(reports[1]);
  assert.ok(press && release, `${label} must emit SGR mouse reports`);
  assert.deepEqual(
    { button: press.button, column: press.column, row: press.row, final: press.final },
    { button: 0, column: press.column, row: press.row, final: "M" },
  );
  assert.deepEqual(
    { button: release.button, column: release.column, row: release.row, final: release.final },
    { button: 0, column: press.column, row: press.row, final: "m" },
  );
  return { press, release };
}

function parseSgrMouse(report) {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(report);
  if (!match) return null;
  return {
    button: Number(match[1]),
    column: Number(match[2]),
    row: Number(match[3]),
    final: match[4],
  };
}

function escapeReport(report) {
  return report.replaceAll("\x1b", "\\x1b").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function assertFrameEvidence(frame) {
  assert.ok(frame.receivedBytes > 0, "fixture must receive real Herdr PTY bytes");
  assert.ok(frame.animationFrames > 0, "browser must present animation frames");
  assert.ok(["webgl2", "webgpu"].includes(frame.rendererBackend), "Restty renderer backend is unknown");
  assert.ok(frame.canvas?.width > 0 && frame.canvas?.height > 0, "Restty canvas has no backing pixels");
  assert.ok(
    frame.canvas?.clientWidth > 0 && frame.canvas?.clientHeight > 0,
    "Restty canvas is not visible",
  );
}

async function captureScreenshot(browser, path) {
  await browser.screenshot(path);
  const details = await stat(path);
  assert.ok(details.size > 5_000, `browser screenshot is unexpectedly small: ${details.size} bytes`);
}

async function findExecutable(override, fallback) {
  if (override) {
    const candidate = resolve(override);
    await access(candidate, fsConstants.X_OK);
    return candidate;
  }
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, fallback);
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "EACCES") throw error;
    }
  }
  throw new Error(`${fallback} is not executable on PATH`);
}

async function findFont(override) {
  if (override) {
    const candidate = resolve(override);
    await access(candidate, fsConstants.R_OK);
    return candidate;
  }
  let fontMatch;
  try {
    fontMatch = await runBounded(
      "fc-match",
      ["-f", "%{file}", "Liberation Mono:style=Regular"],
      { timeoutMs: 5_000, maxOutputBytes: 64 * 1024 },
    );
  } catch (error) {
    throw new Error(
      `could not discover Liberation Mono with fontconfig; set HERDR_TEST_FONT: ${errorMessage(error)}`,
    );
  }
  if (!fontMatch) throw new Error("fontconfig returned no Liberation Mono path; set HERDR_TEST_FONT");
  await access(fontMatch, fsConstants.R_OK);
  return resolve(fontMatch);
}

function signalOwnedGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

function groupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

function appendBounded(current, chunk, maximum) {
  const next = current + chunk.toString("utf8");
  return next.length > maximum ? next.slice(next.length - maximum) : next;
}

function assertOwnedTemporaryDirectory(path) {
  const expectedPrefix = join(tmpdir(), "neko-webshell-herdr-pointer-");
  if (!path.startsWith(expectedPrefix) || path.length <= expectedPrefix.length) {
    throw new Error(`refusing to remove unowned temporary directory: ${path}`);
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runHerdrPointerScenario()
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack ?? error}\n`);
      process.exitCode = 1;
    });
}
