import assert from "node:assert/strict";
import test from "node:test";

import { createTerminalRemoteClipboardBridge } from "./terminal-remote-clipboard.ts";

function osc52(text, terminator = "\u0007") {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}${terminator}`;
}

test("copies remote OSC 52 text to the system clipboard and removes the control sequence", async () => {
  const writes = [];
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText: async (text) => writes.push(text),
    onError: (error) => assert.fail(String(error)),
  });

  assert.equal(bridge.beforeRenderOutput(`before${osc52("来自远端")}after`), "beforeafter");
  await bridge.settled();
  assert.deepEqual(writes, ["来自远端"]);
});

test("handles OSC 52 split across output frames with an ST terminator", async () => {
  const writes = [];
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText: async (text) => writes.push(text),
    onError: (error) => assert.fail(String(error)),
  });
  const sequence = osc52("chunked copy", "\u001b\\");

  assert.equal(bridge.beforeRenderOutput(`left${sequence.slice(0, 10)}`), "left");
  assert.equal(bridge.beforeRenderOutput(`${sequence.slice(10)}right`), "right");
  await bridge.settled();
  assert.deepEqual(writes, ["chunked copy"]);
});

test("blocks remote clipboard reads and disabled remote writes", async () => {
  const writes = [];
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => false,
    writeText: async (text) => writes.push(text),
    onError: (error) => assert.fail(String(error)),
  });

  assert.equal(bridge.beforeRenderOutput(`a\u001b]52;c;?\u0007b${osc52("secret")}c`), "abc");
  await bridge.settled();
  assert.deepEqual(writes, []);
});

test("bounds queued remote writes and drops them after the pane becomes inactive", async () => {
  const writes = [];
  let enabled = true;
  let releaseFirstWrite;
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => enabled,
    writeText: async (text) => {
      writes.push(text);
      if (text === "first") await firstWriteBlocked;
    },
    onError: (error) => assert.fail(String(error)),
  });

  bridge.beforeRenderOutput(osc52("first"));
  await Promise.resolve();
  bridge.beforeRenderOutput(osc52("second"));
  bridge.beforeRenderOutput(osc52("latest"));
  enabled = false;
  releaseFirstWrite();

  await bridge.settled();
  assert.deepEqual(writes, ["first"]);
});

test("coalesces a burst of queued remote writes to the latest text", async () => {
  const writes = [];
  let releaseFirstWrite;
  const firstWriteBlocked = new Promise((resolve) => {
    releaseFirstWrite = resolve;
  });
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText: async (text) => {
      writes.push(text);
      if (text === "first") await firstWriteBlocked;
    },
    onError: (error) => assert.fail(String(error)),
  });

  bridge.beforeRenderOutput(osc52("first"));
  await Promise.resolve();
  bridge.beforeRenderOutput(osc52("second"));
  bridge.beforeRenderOutput(osc52("latest"));
  releaseFirstWrite();

  await bridge.settled();
  assert.deepEqual(writes, ["first", "latest"]);
});
