import assert from "node:assert/strict";
import test from "node:test";

import {
  beginTerminalReplayBuffer,
  bufferTerminalReplayBytes,
  discardTerminalReplayBuffer,
  drainTerminalReplayBuffer,
} from "./terminal-replay-buffer.ts";

test("holds replay frames and drains them as one ordered terminal update", () => {
  const pane = {};
  beginTerminalReplayBuffer(pane);

  assert.equal(bufferTerminalReplayBytes(pane, new TextEncoder().encode("old ")), true);
  assert.equal(bufferTerminalReplayBytes(pane, new TextEncoder().encode("latest")), true);

  const replay = drainTerminalReplayBuffer(pane);
  assert.equal(new TextDecoder().decode(replay), "old latest");
  assert.equal(drainTerminalReplayBuffer(pane), undefined);
  assert.equal(bufferTerminalReplayBytes(pane, new Uint8Array([1])), false);
});

test("discards an incomplete replay without exposing partial terminal state", () => {
  const pane = {};
  beginTerminalReplayBuffer(pane);
  bufferTerminalReplayBytes(pane, new TextEncoder().encode("partial"));

  discardTerminalReplayBuffer(pane);

  assert.equal(drainTerminalReplayBuffer(pane), undefined);
});
