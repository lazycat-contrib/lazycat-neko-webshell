import assert from "node:assert/strict";
import test from "node:test";

import {
  beginTerminalReplayBuffer,
  bufferTerminalReplayBytes,
  discardTerminalReplayBuffer,
  takeTerminalReplayBatch,
  terminalReplayBufferStats,
} from "./terminal-replay-buffer.ts";

test("drains replay in bounded ordered batches without one full-history allocation", () => {
  const pane = {};
  beginTerminalReplayBuffer(pane);
  assert.equal(bufferTerminalReplayBytes(pane, Uint8Array.from([1, 2, 3])), true);
  assert.equal(bufferTerminalReplayBytes(pane, Uint8Array.from([4, 5, 6, 7])), true);
  assert.deepEqual([...takeTerminalReplayBatch(pane, 4)], [1, 2, 3, 4]);
  assert.deepEqual([...takeTerminalReplayBatch(pane, 4)], [5, 6, 7]);
  assert.equal(takeTerminalReplayBatch(pane, 4), undefined);
  assert.deepEqual(terminalReplayBufferStats(pane), {
    bufferedBytes: 0,
    totalBytes: 7,
    chunkCount: 2,
  });
});

test("splits a single oversized chunk at the byte budget", () => {
  const pane = {};
  beginTerminalReplayBuffer(pane);
  bufferTerminalReplayBytes(pane, Uint8Array.from([1, 2, 3, 4, 5]));
  assert.deepEqual([...takeTerminalReplayBatch(pane, 2)], [1, 2]);
  assert.deepEqual([...takeTerminalReplayBatch(pane, 2)], [3, 4]);
  assert.deepEqual([...takeTerminalReplayBatch(pane, 2)], [5]);
});

test("discard rejects subsequent replay bytes", () => {
  const pane = {};
  beginTerminalReplayBuffer(pane);
  discardTerminalReplayBuffer(pane);
  assert.equal(bufferTerminalReplayBytes(pane, Uint8Array.of(1)), false);
  assert.equal(terminalReplayBufferStats(pane), undefined);
});
