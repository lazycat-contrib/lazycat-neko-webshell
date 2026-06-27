export type WebshellSocketUrlOptions = {
  selector: string;
  sessionId: string;
  paneId: string;
  sessionBackend: string;
  cols: number;
  rows: number;
  restart: boolean;
  after: number;
  outputLimit: number;
  controlMode?: "single";
};

export function webshellTerminalSocketUrl(options: WebshellSocketUrlOptions): URL {
  const url = new URL("./ws/terminal", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("backend", options.sessionBackend || "webshell");
  if ((options.sessionBackend || "webshell") === "webshell") {
    url.searchParams.set("name", options.selector);
    if (options.sessionId) {
      url.searchParams.set("session_id", options.sessionId);
    }
  } else {
    url.searchParams.set("session_id", options.sessionId);
  }
  url.searchParams.set("pane_id", options.paneId);
  url.searchParams.set("cols", String(options.cols));
  url.searchParams.set("rows", String(options.rows));
  url.searchParams.set("restart", String(options.restart));
  url.searchParams.set("replay", "true");
  url.searchParams.set("after", String(options.after));
  url.searchParams.set("output_limit", String(options.outputLimit));
  if (options.controlMode) {
    url.searchParams.set("control_mode", options.controlMode);
  }
  return url;
}

export function webshellResizeMessage(cols: number, rows: number): string {
  return JSON.stringify({ type: "resize", cols, rows });
}

export function webshellOutputBufferMessage(limit: number): string {
  return JSON.stringify({ type: "output-buffer", limit });
}

export function webshellRestartPolicyMessage(enabled: boolean): string {
  return JSON.stringify({ type: "restart-policy", enabled });
}

export function webshellTakeControlMessage(): string {
  return JSON.stringify({ type: "take-control" });
}

export function webshellReleaseControlMessage(): string {
  return JSON.stringify({ type: "release-control" });
}

export function webshellHistoryRecordingMessage(enabled: boolean): string {
  return JSON.stringify({ type: "history-recording", enabled });
}
