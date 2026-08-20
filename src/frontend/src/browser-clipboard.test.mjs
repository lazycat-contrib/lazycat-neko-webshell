import assert from "node:assert/strict";
import test from "node:test";

import {
  createSystemClipboardWriter,
  writeSystemClipboardText,
} from "./browser-clipboard.ts";
import { createSerializedTerminalRemoteClipboardWriter } from "./terminal-remote-clipboard.ts";

test("writes through the modern system clipboard when available", async () => {
  const writes = [];
  let fallbackCalls = 0;

  await writeSystemClipboardText("remote text", {
    writeText: async (text) => writes.push(text),
    fallbackCopy: () => {
      fallbackCalls += 1;
      return true;
    },
  });

  assert.deepEqual(writes, ["remote text"]);
  assert.equal(fallbackCalls, 0);
});

test("uses a truthful legacy fallback and rejects when the browser blocks both paths", async () => {
  await assert.doesNotReject(() => writeSystemClipboardText("fallback", {
    writeText: async () => { throw new Error("blocked"); },
    fallbackCopy: () => true,
  }));

  await assert.rejects(() => writeSystemClipboardText("blocked", {
    writeText: async () => { throw new Error("permission denied"); },
    fallbackCopy: () => false,
  }), /permission denied/);
});

test("opens a fallback circuit after one native clipboard write stalls", async () => {
  const nativeWrites = [];
  const fallbackWrites = [];
  const neverSettles = new Promise(() => {});
  const writer = createSystemClipboardWriter({ nativeStallTimeoutMs: 5 });
  const options = {
    writeText: async (text) => {
      nativeWrites.push(text);
      await neverSettles;
    },
    fallbackCopy: (text) => {
      fallbackWrites.push(text);
      return true;
    },
  };

  void writer("stalled", options);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writer("retry", options);
  await writer("newer", options);

  assert.deepEqual(nativeWrites, ["stalled"]);
  assert.deepEqual(fallbackWrites, ["retry", "newer"]);
});

test("closes the fallback circuit after the stalled native write settles", async () => {
  let releaseNativeWrite;
  const nativeWriteBlocked = new Promise((resolve) => {
    releaseNativeWrite = resolve;
  });
  const nativeWrites = [];
  const fallbackWrites = [];
  const writer = createSystemClipboardWriter({ nativeStallTimeoutMs: 5 });
  const options = {
    writeText: async (text) => {
      nativeWrites.push(text);
      await nativeWriteBlocked;
    },
    fallbackCopy: (text) => {
      fallbackWrites.push(text);
      return true;
    },
  };

  const stalled = writer("stalled", options);
  await new Promise((resolve) => setTimeout(resolve, 10));
  await writer("fallback", options);
  releaseNativeWrite();
  await stalled;
  await writer("recovered", options);

  assert.deepEqual(nativeWrites, ["stalled", "recovered"]);
  assert.deepEqual(fallbackWrites, ["fallback"]);
});

test("does not run a late fallback after the clipboard source is invalidated", async () => {
  let sourceActive = true;
  let rejectNativeWrite;
  const nativeWrite = new Promise((_, reject) => {
    rejectNativeWrite = reject;
  });
  const fallbackWrites = [];
  const writer = createSystemClipboardWriter();
  const write = writer("stale-sensitive", {
    writeText: async () => nativeWrite,
    fallbackCopy: (text) => {
      fallbackWrites.push(text);
      return true;
    },
    isCurrent: () => sourceActive,
  });

  sourceActive = false;
  rejectNativeWrite(new Error("blocked late"));
  await write;

  assert.deepEqual(fallbackWrites, []);
});

test("does not fallback an older request after a newer coordinated write succeeds", async () => {
  let rejectOlderNativeWrite;
  const olderNativeWrite = new Promise((_, reject) => {
    rejectOlderNativeWrite = reject;
  });
  const fallbackWrites = [];
  const browserWriter = createSystemClipboardWriter({ nativeStallTimeoutMs: 3 });
  const coordinatedWriter = createSerializedTerminalRemoteClipboardWriter(
    (text, isCurrent) => browserWriter(text, {
      writeText: async () => olderNativeWrite,
      fallbackCopy: (fallbackText) => {
        fallbackWrites.push(fallbackText);
        return true;
      },
      isCurrent,
    }),
    { operationTimeoutMs: 10 },
  );

  const older = coordinatedWriter("older");
  await Promise.resolve();
  const newer = coordinatedWriter("newer");
  assert.equal(await newer, true);
  assert.equal(await older, false);

  rejectOlderNativeWrite(new Error("older native write rejected late"));
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(fallbackWrites.includes("older"), false);
  assert.equal(fallbackWrites.at(-1), "newer");
});
