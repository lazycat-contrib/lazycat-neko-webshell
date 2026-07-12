import assert from "node:assert/strict";
import test from "node:test";

import {
  filterRemoteClientPluginTools,
  isRemoteClientSelector,
  remoteClientNewTabCapabilities,
  remoteClientReplayInputPolicy,
  resetRemoteClientTerminalForReplay,
} from "./remote-client-terminal.ts";

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
