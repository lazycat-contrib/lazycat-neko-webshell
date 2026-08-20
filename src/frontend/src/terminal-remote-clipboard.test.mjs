import assert from "node:assert/strict";
import test from "node:test";

import {
  createSerializedTerminalRemoteClipboardWriter,
  createTerminalRemoteClipboardBridge,
  createTerminalRemoteClipboardSourceWriter,
} from "./terminal-remote-clipboard.ts";

function osc52(text, terminator = "\u0007") {
  return `\u001b]52;c;${Buffer.from(text, "utf8").toString("base64")}${terminator}`;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, timeoutMilliseconds = 100) {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition was not met before timeout");
    await delay(1);
  }
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

test("does not resume a disabled OSC 52 fragment after clipboard access is enabled", async () => {
  const writes = [];
  let enabled = false;
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => enabled,
    writeText: async (text) => writes.push(text),
    onError: (error) => assert.fail(String(error)),
  });
  const sequence = osc52("disabled fragment");

  assert.equal(bridge.beforeRenderOutput(sequence.slice(0, -3)), "");
  enabled = true;
  assert.equal(bridge.beforeRenderOutput(`${sequence.slice(-3)}visible`), "visible");
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

test("preserves blocked clipboard text for a user-activated retry", async () => {
  const blocked = [];
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText: async () => {
      throw new Error("permission denied");
    },
    onWriteError: (error, text) => blocked.push([String(error), text]),
    onError: (error) => assert.fail(String(error)),
  });

  bridge.beforeRenderOutput(osc52("retry me"));
  await bridge.settled();

  assert.deepEqual(blocked, [["Error: permission denied", "retry me"]]);
});

test("reports the text whose automatic clipboard write succeeded", async () => {
  const copied = [];
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText: async () => {},
    onCopied: (text) => copied.push(text),
    onError: (error) => assert.fail(String(error)),
  });

  bridge.beforeRenderOutput(osc52("newer"));
  await bridge.settled();

  assert.deepEqual(copied, ["newer"]);
});

test("skips a queued clipboard write whose source pane becomes inactive", async () => {
  let releaseBlockingWrite;
  const blockingWrite = new Promise((resolve) => {
    releaseBlockingWrite = resolve;
  });
  const writes = [];
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    if (text === "blocking") await blockingWrite;
    writes.push(text);
  });
  let sourceActive = true;
  const source = createTerminalRemoteClipboardSourceWriter(
    writeText,
    () => sourceActive,
  );

  const blocking = writeText("blocking", () => true);
  await Promise.resolve();
  const queued = source.writeText("stale");
  sourceActive = false;
  source.invalidate();
  sourceActive = true;
  releaseBlockingWrite();

  assert.equal(await blocking, true);
  assert.equal(await queued, false);
  assert.deepEqual(writes, ["blocking"]);
});

test("allows a newer clipboard write to complete when an older browser write never settles", async () => {
  const writes = [];
  const neverSettles = new Promise(() => {});
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    writes.push(text);
    if (text === "stalled") await neverSettles;
  }, { operationTimeoutMs: 10 });

  const stalled = writeText("stalled").catch((error) => error);
  await Promise.resolve();
  const latest = writeText("latest");
  const result = await Promise.race([
    latest,
    delay(50).then(() => "deadline"),
  ]);

  assert.equal(result, true);
  assert.equal(await stalled, false);
  assert.deepEqual(writes, ["stalled", "latest"]);
});

test("reports a bounded timeout for the latest stalled clipboard write", async () => {
  const neverSettles = new Promise(() => {});
  const writeText = createSerializedTerminalRemoteClipboardWriter(async () => {
    await neverSettles;
  }, { operationTimeoutMs: 10 });

  await assert.rejects(writeText("stalled"), /timed out/i);
});

test("replays the latest clipboard text after an older timed-out write succeeds late", async () => {
  let clipboard = "";
  let releaseOlderWrite;
  const olderWriteBlocked = new Promise((resolve) => {
    releaseOlderWrite = resolve;
  });
  const writes = [];
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    writes.push(text);
    if (text === "older") await olderWriteBlocked;
    clipboard = text;
  }, { operationTimeoutMs: 10 });

  const older = writeText("older");
  await Promise.resolve();
  assert.equal(await writeText("newer"), true);
  assert.equal(clipboard, "newer");
  assert.equal(await older, false);

  releaseOlderWrite();
  await waitFor(() => writes.filter((text) => text === "newer").length === 2);
  assert.equal(clipboard, "newer");
});

test("reports a failed late reconciliation to the latest clipboard owner", async () => {
  let clipboard = "";
  let releaseOlderWrite;
  const olderWriteBlocked = new Promise((resolve) => {
    releaseOlderWrite = resolve;
  });
  let newerAttempts = 0;
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    if (text === "older") {
      await olderWriteBlocked;
      clipboard = text;
      return;
    }
    newerAttempts += 1;
    if (newerAttempts > 1) throw new Error("reconciliation blocked");
    clipboard = text;
  }, { operationTimeoutMs: 10 });
  const reconciliationErrors = [];

  const older = writeText("older");
  await Promise.resolve();
  assert.equal(await writeText(
    "newer",
    () => true,
    (error, text) => reconciliationErrors.push([String(error), text]),
  ), true);
  assert.equal(await older, false);

  releaseOlderWrite();
  await waitFor(() => reconciliationErrors.length === 1);
  assert.equal(clipboard, "older");
  assert.deepEqual(reconciliationErrors, [["Error: reconciliation blocked", "newer"]]);
});

test("does not report a stale clipboard timeout after a newer write completes", async () => {
  const neverSettles = new Promise(() => {});
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    if (text === "stalled") await neverSettles;
  }, { operationTimeoutMs: 10 });
  const blocked = [];
  const staleBridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText,
    onWriteError: (error, text) => blocked.push([String(error), text]),
    onError: (error) => assert.fail(String(error)),
  });
  const latestBridge = createTerminalRemoteClipboardBridge({
    enabled: () => true,
    writeText,
    onWriteError: (error, text) => blocked.push([String(error), text]),
    onError: (error) => assert.fail(String(error)),
  });

  staleBridge.beforeRenderOutput(osc52("stalled"));
  await Promise.resolve();
  latestBridge.beforeRenderOutput(osc52("latest"));
  await Promise.all([staleBridge.settled(), latestBridge.settled()]);

  assert.deepEqual(blocked, []);
});

test("drops bridge-local queued text and split OSC 52 after source invalidation", async () => {
  let releaseBlockingWrite;
  const blockingWrite = new Promise((resolve) => {
    releaseBlockingWrite = resolve;
  });
  const writes = [];
  const writeText = createSerializedTerminalRemoteClipboardWriter(async (text) => {
    if (text === "blocking") await blockingWrite;
    writes.push(text);
  });
  let sourceActive = true;
  const source = createTerminalRemoteClipboardSourceWriter(
    writeText,
    () => sourceActive,
  );
  const bridge = createTerminalRemoteClipboardBridge({
    enabled: () => sourceActive,
    writeText: source.writeText,
    prepareWrite: source.prepareWrite,
    onError: (error) => assert.fail(String(error)),
  });
  const splitSequence = osc52("split stale");

  const blocking = writeText("blocking", () => true);
  bridge.beforeRenderOutput(osc52("first stale"));
  await Promise.resolve();
  bridge.beforeRenderOutput(osc52("queued stale"));
  bridge.beforeRenderOutput(splitSequence.slice(0, -1));
  sourceActive = false;
  source.invalidate();
  bridge.reset();
  sourceActive = true;
  bridge.beforeRenderOutput(splitSequence.slice(-1));
  releaseBlockingWrite();

  await Promise.all([blocking, bridge.settled()]);
  assert.deepEqual(writes, ["blocking"]);
});
