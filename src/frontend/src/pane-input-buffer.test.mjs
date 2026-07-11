import assert from "node:assert/strict";
import test from "node:test";

import {
  clearPanePendingInput,
  flushPanePendingInput,
  paneReplayAfter,
  queuePanePendingInput,
} from "./pane-input-buffer.ts";

function pane() {
  return {
    pendingInput: [],
    pendingInputBytes: 0,
    lastOutputSequence: 100,
    sessionBackend: "herdr",
  };
}

test("keeps pending input within the byte budget by dropping the oldest input", () => {
  const target = pane();
  const bytes = (value) => new TextEncoder().encode(value).byteLength;

  assert.equal(queuePanePendingInput(target, "ab", 4, bytes), true);
  assert.equal(queuePanePendingInput(target, "cde", 4, bytes), true);

  assert.deepEqual(target.pendingInput, ["cde"]);
  assert.equal(target.pendingInputBytes, 3);
});

test("restores unsent input when flushing fails", () => {
  const target = pane();
  const bytes = (value) => new TextEncoder().encode(value).byteLength;
  queuePanePendingInput(target, "hello", 16, bytes);

  assert.equal(flushPanePendingInput(target, () => false, bytes), false);
  assert.deepEqual(target.pendingInput, ["hello"]);
  assert.equal(target.pendingInputBytes, 5);
});

test("calculates a Herdr replay tail without affecting other backends", () => {
  const target = pane();
  assert.equal(paneReplayAfter(target, 80), 20);
  target.sessionBackend = "webshell";
  assert.equal(paneReplayAfter(target, 80), 100);
});

test("clears buffered input state", () => {
  const target = pane();
  target.pendingInput = ["x"];
  target.pendingInputBytes = 1;
  clearPanePendingInput(target);
  assert.deepEqual(target.pendingInput, []);
  assert.equal(target.pendingInputBytes, 0);
});
