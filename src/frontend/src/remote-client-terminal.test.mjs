import assert from "node:assert/strict";
import test from "node:test";

import {
  filterRemoteClientPluginTools,
  isRemoteClientSelector,
  remoteClientNewTabCapabilities,
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
