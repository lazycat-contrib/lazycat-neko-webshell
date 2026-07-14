import assert from "node:assert/strict";
import test from "node:test";

import {
  filterRemoteClientPluginTools,
  installRemoteClientKeepalive,
  isRemoteClientSelector,
  remoteClientNewTabCapabilities,
  remoteClientProcessExitShouldRetry,
  remoteClientReplayLockTimeout,
  remoteClientReplayInputPolicy,
  resetRemoteClientTerminalForReplay,
} from "./remote-client-terminal.ts";
import { webshellGeneratedInputMessage } from "./webshell-backend.ts";
import { terminalThemeSocketColors } from "./terminal-theme-wire.ts";

test("recognizes only typed remote client selectors", () => {
  assert.equal(isRemoteClientSelector("client:client-a"), true);
  assert.equal(isRemoteClientSelector(" client:client-a "), true);
  assert.equal(isRemoteClientSelector("alpha@deploy-a"), false);
  assert.equal(isRemoteClientSelector("client:"), false);
});

test("hides LightOS-only tools for remote client terminals", () => {
  const tools = [
    { id: "file-transfer" },
    { id: "lightos-port-forward" },
    { id: "ai-chat" },
  ];
  const unsupported = new Set(["file-transfer", "lightos-port-forward"]);

  assert.deepEqual(
    filterRemoteClientPluginTools("client:client-a", tools, unsupported),
    [{ id: "ai-chat" }],
  );
  assert.equal(
    filterRemoteClientPluginTools("alpha@deploy-a", tools, unsupported),
    tools,
  );
});

test("remote clients expose only their native WebShell backend", () => {
  assert.deepEqual(remoteClientNewTabCapabilities("client:client-a", true), {
    lightosDirectAvailable: false,
    sshAvailable: false,
  });
  assert.deepEqual(remoteClientNewTabCapabilities("alpha@deploy-a", true), {
    lightosDirectAvailable: true,
    sshAvailable: true,
  });
});

test("retries transient remote process exits but not missing panes", () => {
  assert.equal(
    remoteClientProcessExitShouldRetry("client:client-a", {
      retryable: true,
      message: "remote agent is restarting",
    }),
    true,
  );
  assert.equal(
    remoteClientProcessExitShouldRetry("client:client-a", {
      retryable: true,
      message: "pane not found",
    }),
    false,
  );
  assert.equal(
    remoteClientProcessExitShouldRetry("alpha@deploy-a", {
      retryable: true,
      message: "remote agent is restarting",
    }),
    false,
  );
});

test("keeps the Go remote attach socket alive before its 30 second timeout", () => {
  const scheduled = [];
  const cleared = [];
  const sent = [];
  const listeners = new Map();
  const clock = {
    setInterval(callback, delay) {
      scheduled.push({ callback, delay });
      return 7;
    },
    clearInterval(id) {
      cleared.push(id);
    },
  };
  const socket = {
    readyState: 1,
    send(message) {
      sent.push(message);
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
  };

  const stop = installRemoteClientKeepalive("client:client-a", socket, clock);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 10_000);
  scheduled[0].callback();
  assert.deepEqual(sent, [JSON.stringify({ type: "ping" })]);
  listeners.get("close")();
  stop();
  assert.deepEqual(cleared, [7]);

  installRemoteClientKeepalive("alpha@deploy-a", socket, clock);
  assert.equal(scheduled.length, 1);
});

test("allows the Go agent preparation window before releasing queued input", () => {
  assert.equal(
    remoteClientReplayLockTimeout("client:client-a", "agent-preparing", 5_000),
    45_000,
  );
  assert.equal(
    remoteClientReplayLockTimeout("alpha@deploy-a", "agent-preparing", 5_000),
    5_000,
  );
  assert.equal(
    remoteClientReplayLockTimeout("client:client-a", "replay-start", 5_000),
    5_000,
  );
});

test("suppresses generated terminal responses on secondary remote replays", () => {
  assert.equal(
    remoteClientReplayInputPolicy("client:client-a", true, false, "\x1b[12;34R"),
    "suppress",
  );
  assert.equal(
    remoteClientReplayInputPolicy("client:client-a", true, true, "\x1b[?1;2c"),
    "immediate",
  );
  assert.equal(
    remoteClientReplayInputPolicy("client:client-a", true, false, "ls\r"),
    "normal",
  );
  assert.equal(
    remoteClientReplayInputPolicy("alpha@deploy-a", true, false, "\x1b[12;34R"),
    "normal",
  );
});

test("marks the allowed replay response as generated input for the Go agent", () => {
  assert.equal(
    webshellGeneratedInputMessage("\x1b[12;34R"),
    JSON.stringify({ type: "input", data: "\x1b[12;34R", generated: true }),
  );
});

test("converts the active Restty theme to Go terminal attach colors", () => {
  assert.deepEqual(
    terminalThemeSocketColors({
      colors: {
        foreground: { r: 1, g: 2, b: 3 },
        background: { r: 250, g: 251, b: 252 },
        cursor: { r: 16, g: 32, b: 48 },
      },
    }),
    {
      foreground: "#010203",
      background: "#fafbfc",
      cursor: "#102030",
    },
  );
});

test("covers every automatic reply emitted by the bundled Restty terminal", () => {
  const generatedReplies = [
    "\x1b]10;rgb:ffff/ffff/ffff\x07",
    "\x1b]11;rgb:0000/0000/0000\x07",
    "\x1b]12;rgb:ffff/ffff/ffff\x07",
    "\x1b]52;c;Y2xpcGJvYXJk\x07",
    "\x1b]52;;Y2xpcGJvYXJk\x07",
    "\x1b]52;clipboard-target-longer-than-sixteen;Y2xpcGJvYXJk\x07",
    "\x1b[4;1080;1920t",
    "\x1b[6;20;10t",
    "\x1b[8;32;120t",
    "\x1bP>|ghostty 1.0\x1b\\",
    "[12;34R",
    "12;34R",
    ";34R",
    "34R",
    "4R",
  ];

  for (const reply of generatedReplies) {
    assert.equal(
      remoteClientReplayInputPolicy("client:client-a", true, false, reply),
      "suppress",
      JSON.stringify(reply),
    );
    assert.equal(
      remoteClientReplayInputPolicy("client:client-a", true, true, reply),
      "immediate",
      JSON.stringify(reply),
    );
  }

  assert.equal(
    remoteClientReplayInputPolicy(
      "client:client-a",
      true,
      false,
      generatedReplies.join(""),
    ),
    "suppress",
  );
  assert.equal(
    remoteClientReplayInputPolicy("client:client-a", true, false, "printf '\\e[8;32;120t'\r"),
    "normal",
  );
});

test("resets terminal state only for remote history replay", () => {
  let resets = 0;
  const remotePane = {
    selector: "client:client-a",
    term: { reset: () => { resets += 1; } },
    decoder: undefined,
    lastOutputSequence: 42,
  };
  const localPane = {
    selector: "alpha@deploy-a",
    term: { reset: () => { resets += 1; } },
    decoder: undefined,
    lastOutputSequence: 42,
  };

  assert.equal(resetRemoteClientTerminalForReplay(remotePane), true);
  assert.equal(remotePane.lastOutputSequence, 0);
  assert.ok(remotePane.decoder instanceof TextDecoder);
  assert.equal(resetRemoteClientTerminalForReplay(localPane), false);
  assert.equal(localPane.lastOutputSequence, 42);
  assert.equal(resets, 1);
});
