import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalReplayController } from "./terminal-replay-controller.ts";

function pane() {
  return {
    id: "pane-1",
    replaying: false,
    allowGeneratedInputDuringReplay: false,
    closing: false,
  };
}

test("renders replay in bounded batches and advances only rendered cursors", async () => {
  const writes = [];
  const sequences = [];
  const target = pane();
  const controller = createTerminalReplayController({
    byteBudget: 3,
    writeBytes: (_pane, bytes) => writes.push([...bytes]),
    updateSequence: (_pane, sequence) => sequences.push(sequence),
    onUnlocked: () => undefined,
    debugEnabled: () => false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    setTimer: () => 1,
    clearTimer: () => undefined,
    nextFrame: async () => undefined,
    now: () => 0,
  });
  controller.validate(target);
  controller.push(target, Uint8Array.from([1, 2, 3, 4, 5]));
  controller.markSequence(target, 9);
  assert.deepEqual(sequences, []);
  assert.equal(await controller.finish(target), true);
  assert.deepEqual(writes, [[1, 2, 3], [4, 5]]);
  assert.deepEqual(sequences, [9]);
  assert.equal(target.replaying, false);
});

test("clearing a replay prevents an older finish from unlocking input", async () => {
  let unlocked = 0;
  const target = pane();
  const controller = createTerminalReplayController({
    byteBudget: 1,
    writeBytes: () => undefined,
    updateSequence: () => undefined,
    onUnlocked: () => { unlocked += 1; },
    debugEnabled: () => false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    setTimer: () => 1,
    clearTimer: () => undefined,
    nextFrame: async () => controller.clear(target),
    now: () => 0,
  });
  controller.validate(target);
  controller.push(target, Uint8Array.from([1, 2]));
  assert.equal(await controller.finish(target), false);
  assert.equal(unlocked, 0);
});

test("can discard stale replay state without resetting the rendered terminal", () => {
  let interrupted = 0;
  const target = pane();
  const controller = createTerminalReplayController({
    byteBudget: 8,
    writeBytes: () => undefined,
    updateSequence: () => undefined,
    onUnlocked: () => undefined,
    onInterrupted: () => { interrupted += 1; },
    debugEnabled: () => false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    setTimer: () => 1,
    clearTimer: () => undefined,
    nextFrame: async () => undefined,
    now: () => 0,
  });
  controller.validate(target);
  controller.push(target, Uint8Array.from([1, 2, 3]));
  controller.clear(target, { interrupted: false });
  assert.equal(interrupted, 0);
  assert.equal(target.replaying, false);
});

test("does not render bytes until replay identity is validated", async () => {
  const writes = [];
  const target = pane();
  const controller = createTerminalReplayController({
    byteBudget: 8,
    writeBytes: (_pane, bytes) => writes.push([...bytes]),
    updateSequence: () => undefined,
    onUnlocked: () => undefined,
    debugEnabled: () => false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    setTimer: () => 1,
    clearTimer: () => undefined,
    nextFrame: async () => undefined,
    now: () => 0,
  });
  controller.begin(target);
  assert.equal(controller.push(target, Uint8Array.from([1, 2, 3])), true);
  assert.deepEqual(writes, []);
  controller.validate(target);
  assert.equal(await controller.finish(target), true);
  assert.deepEqual(writes, []);
});

test("keeps live output after replay-complete ordered after replay and its boundary", async () => {
  const events = [];
  const target = pane();
  const controller = createTerminalReplayController({
    byteBudget: 2,
    writeBytes: (_pane, bytes) => events.push(`bytes:${[...bytes].join(",")}`),
    updateSequence: (_pane, sequence) => events.push(`live:${sequence}`),
    updateReplayBoundary: (_pane, sequence) => events.push(`replay:${sequence}`),
    onUnlocked: () => events.push("unlocked"),
    debugEnabled: () => false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    setTimer: () => 1,
    clearTimer: () => undefined,
    nextFrame: async () => {
      controller.push(target, Uint8Array.from([9]));
      controller.markSequence(target, 12);
    },
    now: () => 0,
  });
  controller.validate(target);
  controller.push(target, Uint8Array.from([1, 2, 3]));
  assert.equal(await controller.finish(target, 10), true);
  assert.deepEqual(events, [
    "bytes:1,2",
    "bytes:3",
    "replay:10",
    "bytes:9",
    "live:12",
    "unlocked",
  ]);
});

test("aborts and reconnects when live output exceeds the bounded handoff queue", async () => {
  let overflows = 0;
  const target = pane();
  const controller = createTerminalReplayController({
    byteBudget: 1,
    maxLiveBytes: 1,
    writeBytes: () => undefined,
    updateSequence: () => undefined,
    onUnlocked: () => undefined,
    onOverflow: () => { overflows += 1; },
    debugEnabled: () => false,
    requestFrame: () => 1,
    cancelFrame: () => undefined,
    setTimer: () => 1,
    clearTimer: () => undefined,
    nextFrame: async () => {
      controller.push(target, Uint8Array.from([9, 10]));
    },
    now: () => 0,
  });
  controller.validate(target);
  controller.push(target, Uint8Array.from([1, 2]));
  assert.equal(await controller.finish(target), false);
  assert.equal(overflows, 1);
  assert.equal(target.replaying, false);
});
