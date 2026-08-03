type RemoteReplayPane = {
  selector: string;
  term?: { reset(): void };
  decoder?: TextDecoder;
  lastOutputSequence: number;
};

export type RemoteReplayInputPolicy = "normal" | "suppress" | "immediate";

// Restty emits these replies directly through PtyTransport.sendInput.
// Keep this grammar aligned with its cursor/device, window, color, clipboard,
// terminal-version, and Kitty graphics response paths so replay observers never answer twice.
const generatedTerminalResponsePatterns = [
  /^\x1b\[(?:\d{1,6};\d{1,6}R|\d{1,6}R|0n|\?[\d;]{1,32}c|>[\d;]{1,32}c)/,
  /^\x1b\[(?:4|6|8);\d{1,8};\d{1,8}t/,
  /^\x1bP>\|ghostty [ -~]{1,64}\x1b\\/,
  /^\x1b_G(?:(?:i|I|p)=\d{1,10})(?:,(?:i|I|p)=\d{1,10})*;[ -~]{1,256}\x1b\\/,
  /^\x1b\](?:10|11|12);rgb:[\da-fA-F]{4}\/[\da-fA-F]{4}\/[\da-fA-F]{4}\x07/,
  /^\x1b\]52;[^;\x07\x1b]*;[A-Za-z\d+/=]*\x07/,
] as const;
const generatedTerminalResponseTailPattern = /^(?:\[\d{1,6};\d{1,6}R|\[\d{1,6}R|\d{1,6};\d{1,6}R|;\d{1,6}R|\d{1,6}R|\dR)+$/;

export type RemoteClientNewTabCapabilities = {
  lightosDirectAvailable: boolean;
  sshAvailable: boolean;
};

type RemoteProcessExit = {
  retryable?: boolean;
  message?: string;
};

type RemoteHerdrPane = {
  selector: string;
  sessionBackend: string;
  programKind?: string;
};

type RemoteKeepaliveSocket = {
  readyState: number;
  send(message: string): void;
  close?(): void;
  addEventListener(
    type: "close" | "error",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
};

type RemoteKeepaliveClock = {
  setInterval(callback: () => void, delay: number): number;
  clearInterval(id: number): void;
};

const REMOTE_CLIENT_KEEPALIVE_INTERVAL_MS = 10_000;
const REMOTE_CLIENT_AGENT_PREPARE_TIMEOUT_MS = 45_000;

export function isRemoteClientSelector(value: unknown): boolean {
  const selector = String(value ?? "").trim();
  const id = selector.startsWith("client:") ? selector.slice("client:".length) : "";
  return Boolean(
    id
      && id.length <= 256
      && [...id].every((character) => /[A-Za-z0-9._-]/.test(character)),
  );
}

export function isRemoteHerdrPane(pane: RemoteHerdrPane): boolean {
  return isRemoteClientSelector(pane.selector)
    && pane.sessionBackend === "webshell"
    && pane.programKind === "herdr";
}

export function remoteClientNewTabCapabilities(
  selector: string,
  lightosDirectAvailable: boolean,
): RemoteClientNewTabCapabilities {
  const remoteClient = isRemoteClientSelector(selector);
  return {
    lightosDirectAvailable: lightosDirectAvailable && !remoteClient,
    sshAvailable: !remoteClient,
  };
}

export function remoteClientProcessExitShouldRetry(
  selector: string,
  event: RemoteProcessExit,
): boolean {
  return Boolean(
    isRemoteClientSelector(selector)
      && event.retryable === true
      && !/pane not found/i.test(String(event.message ?? "")),
  );
}

export function installRemoteClientKeepalive(
  selector: string,
  socket: RemoteKeepaliveSocket,
  clock: RemoteKeepaliveClock = window,
): () => void {
  if (!isRemoteClientSelector(selector)) return () => {};
  let active = true;
  let timer = 0;
  const stop = () => {
    if (!active) return;
    active = false;
    clock.clearInterval(timer);
  };
  timer = clock.setInterval(() => {
    if (!active || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify({ type: "ping" }));
    } catch {
      stop();
      socket.close?.();
    }
  }, REMOTE_CLIENT_KEEPALIVE_INTERVAL_MS);
  socket.addEventListener("close", stop, { once: true });
  socket.addEventListener("error", stop, { once: true });
  return stop;
}

export function remoteClientReplayLockTimeout(
  selector: string,
  eventType: string,
  defaultTimeoutMs: number,
): number {
  return isRemoteClientSelector(selector) && eventType === "agent-preparing"
    ? REMOTE_CLIENT_AGENT_PREPARE_TIMEOUT_MS
    : defaultTimeoutMs;
}

export function remoteClientReplayInputPolicy(
  selector: string,
  replaying: boolean,
  allowGeneratedInput: boolean,
  data: string,
): RemoteReplayInputPolicy {
  if (!replaying || !isRemoteClientSelector(selector) || !isGeneratedTerminalResponse(data)) {
    return "normal";
  }
  return allowGeneratedInput ? "immediate" : "suppress";
}

function isGeneratedTerminalResponse(data: string): boolean {
  if (!data) return false;
  let remaining = data;
  while (remaining) {
    if (generatedTerminalResponseTailPattern.test(remaining)) return true;
    const match = generatedTerminalResponsePatterns
      .map((pattern) => pattern.exec(remaining))
      .find((candidate) => candidate !== null);
    if (!match) return false;
    remaining = remaining.slice(match[0].length);
  }
  return true;
}

export function resetRemoteClientTerminalForReplay(pane: RemoteReplayPane): boolean {
  if (!isRemoteClientSelector(pane.selector)) return false;
  pane.term?.reset();
  pane.decoder = new TextDecoder();
  pane.lastOutputSequence = 0;
  return true;
}

export function filterRemoteClientPluginTools<T extends { id: string }>(
  selector: string,
  tools: T[],
  unsupportedPluginIds: ReadonlySet<string>,
): T[] {
  if (!isRemoteClientSelector(selector)) return tools;
  return tools.filter((tool) => !unsupportedPluginIds.has(tool.id));
}
