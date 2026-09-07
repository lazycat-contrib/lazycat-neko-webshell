import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export function uniqueBrowserSession(prefix = "browser-test") {
  const safePrefix = prefix.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 32);
  return `${safePrefix}-${process.pid}-${randomBytes(4).toString("hex")}`;
}

export async function verifyBrowserDriverNavigation() {
  const browser = createBrowserDriver({
    session: uniqueBrowserSession("browser-driver-smoke"),
    headed: true,
    commandTimeoutMs: 10_000,
  });
  const url = "data:text/html,<title>browser-driver-smoke</title>ready";
  let primaryError;
  try {
    await browser.open(url);
    const state = await browser.evaluate("({ href: location.href, title: document.title })");
    if (state?.href !== url || state?.title !== "browser-driver-smoke") {
      throw new Error(`browser driver lost its opened page: ${JSON.stringify(state)}`);
    }
    return { status: "passed", title: state.title };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await browser.close();
    } catch (error) {
      if (!primaryError) throw error;
      primaryError.message += `\nBrowser driver smoke cleanup failed: ${error.message}`;
    }
  }
}

export function createBrowserDriver({
  session,
  headed = true,
  launchArgs = "",
  commandTimeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
} = {}) {
  if (!session) throw new Error("browser driver requires an isolated session name");
  let currentUrl = "";
  let opened = false;
  let closed = false;

  const command = async (args, options = {}) => {
    if (closed && args[0] !== "close") throw new Error(`browser session ${session} is closed`);
    return runBounded("agent-browser", ["--session", session, ...args], {
      input: options.input,
      timeoutMs: options.timeoutMs ?? commandTimeoutMs,
      maxOutputBytes,
    });
  };

  return {
    session,
    command,
    async open(url) {
      if (opened) throw new Error(`browser session ${session} is already open`);
      const args = [];
      if (headed) args.push("--headed");
      if (launchArgs) args.push("--args", launchArgs);
      args.push("open", url);
      const output = await command(args);
      currentUrl = url;
      opened = true;
      return output;
    },
    async navigate(url) {
      if (!opened) throw new Error(`browser session ${session} is not open`);
      const output = await command(["open", url]);
      currentUrl = url;
      return output;
    },
    async evaluate(source) {
      const output = await command(["eval", "--stdin"], { input: source });
      return parseCliValue(output);
    },
    async waitFor(source, { timeoutMs = commandTimeoutMs, pollMs = 100 } = {}) {
      const deadline = Date.now() + timeoutMs;
      let lastValue;
      while (Date.now() < deadline) {
        lastValue = await this.evaluate(`(async () => Boolean(await (${source})))()`);
        if (lastValue === true) return;
        await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
      }
      throw new Error(`browser condition timed out after ${timeoutMs}ms: ${source}; last=${lastValue}`);
    },
    async screenshot(path) {
      await command(["screenshot", path]);
      return path;
    },
    async press(key) {
      return command(["press", key]);
    },
    async getCdpUrl() {
      const value = parseCliValue(await command(["get", "cdp-url"]));
      if (typeof value !== "string" || !value.startsWith("ws")) {
        throw new Error(`agent-browser returned an invalid CDP URL: ${String(value)}`);
      }
      return value;
    },
    async dispatchTouch(events) {
      validateInputEvents(events, new Set(["touchStart", "touchMove", "touchEnd", "touchCancel"]));
      return withPageCdp(await this.getCdpUrl(), currentUrl, async (cdp, sessionId) => {
        await cdp.send(
          "Emulation.setTouchEmulationEnabled",
          { enabled: true, maxTouchPoints: 5 },
          sessionId,
        );
        for (const event of events) {
          const { delayMs = 0, ...params } = event;
          await cdp.send("Input.dispatchTouchEvent", params, sessionId);
          if (delayMs > 0) await delay(delayMs);
        }
      });
    },
    async dispatchMouse(events) {
      validateInputEvents(events, new Set(["mouseMoved", "mousePressed", "mouseReleased"]));
      return withPageCdp(await this.getCdpUrl(), currentUrl, async (cdp, sessionId) => {
        for (const event of events) {
          const { delayMs = 0, ...params } = event;
          await cdp.send("Input.dispatchMouseEvent", params, sessionId);
          if (delayMs > 0) await delay(delayMs);
        }
      });
    },
    async close() {
      if (closed) return;
      await command(["close"], { timeoutMs: 10_000 });
      closed = true;
      opened = false;
    },
  };
}

export async function runBounded(
  file,
  args,
  {
    input,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    cwd,
    env,
    inheritEnv = true,
  } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd,
      env: env ? (inheritEnv ? { ...process.env, ...env } : env) : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure;
    let settled = false;
    const timer = setTimeout(() => {
      failure = new Error(`${file} timed out after ${timeoutMs}ms`);
      child.kill("SIGKILL");
    }, timeoutMs);

    const collect = (bucket, chunk, currentBytes, label) => {
      const nextBytes = currentBytes + chunk.byteLength;
      if (nextBytes > maxOutputBytes && !failure) {
        failure = new Error(`${file} ${label} exceeded ${maxOutputBytes} bytes`);
        child.kill("SIGKILL");
      }
      if (currentBytes < maxOutputBytes) {
        bucket.push(chunk.subarray(0, maxOutputBytes - currentBytes));
      }
      return nextBytes;
    };
    child.stdout.on("data", (chunk) => {
      stdoutBytes = collect(stdout, chunk, stdoutBytes, "stdout");
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes = collect(stderr, chunk, stderrBytes, "stderr");
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8").trim();
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (failure) {
        reject(withProcessOutput(failure, output, errorOutput));
      } else if (code !== 0) {
        reject(
          withProcessOutput(
            new Error(`${file} exited with code ${code ?? "none"} signal ${signal ?? "none"}`),
            output,
            errorOutput,
          ),
        );
      } else {
        resolve(output);
      }
    });
    child.stdin.on("error", (error) => {
      if (!failure && error.code !== "EPIPE") failure = error;
    });
    child.stdin.end(input);
  });
}

function parseCliValue(output) {
  if (!output) return undefined;
  try {
    return JSON.parse(output);
  } catch {
    return output;
  }
}

function validateInputEvents(events, allowedTypes) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("CDP input events are required");
  for (const event of events) {
    if (!event || !allowedTypes.has(event.type)) {
      throw new Error(`unsupported CDP input event: ${String(event?.type)}`);
    }
  }
}

async function withPageCdp(endpoint, expectedUrl, operation) {
  const cdp = await CdpClient.connect(endpoint);
  let sessionId;
  let operationError;
  try {
    const { targetInfos } = await cdp.send("Target.getTargets");
    const target = targetInfos.find(
      (candidate) => candidate.type === "page" && candidate.url === expectedUrl,
    );
    if (!target) throw new Error(`browser page target is unavailable for ${expectedUrl}`);
    ({ sessionId } = await cdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    }));
    return await operation(cdp, sessionId);
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    let detachError;
    if (sessionId) {
      try {
        await cdp.send("Target.detachFromTarget", { sessionId });
      } catch (error) {
        if (operationError) operationError.message += `\nCDP detach failed: ${error.message}`;
        else detachError = error;
      }
    }
    cdp.close();
    if (detachError) throw detachError;
  }
}

class CdpClient {
  static async connect(endpoint) {
    const socket = new WebSocket(endpoint);
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("CDP connection timed out")), 5_000);
        socket.addEventListener(
          "open",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
        socket.addEventListener(
          "error",
          () => {
            clearTimeout(timer);
            reject(new Error("CDP connection failed"));
          },
          { once: true },
        );
      });
    } catch (error) {
      socket.close();
      throw error;
    }
    return new CdpClient(socket);
  }

  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close() {
    this.socket.close();
  }
}

function withProcessOutput(error, stdout, stderr) {
  const details = [error.message];
  if (stdout) details.push(`stdout:\n${stdout}`);
  if (stderr) details.push(`stderr:\n${stderr}`);
  error.message = details.join("\n");
  return error;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
