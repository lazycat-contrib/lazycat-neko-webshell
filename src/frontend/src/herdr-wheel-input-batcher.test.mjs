import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrWheelInputBatcher,
  isHerdrWheelInput,
} from "./herdr-wheel-input-batcher.ts";

const herdrPane = { id: "herdr-pane", sessionBackend: "herdr" };
const nativePane = { id: "native-pane", sessionBackend: "webshell" };

function harness() {
  const sent = [];
  const frames = [];
  const cancelled = [];
  const batcher = createHerdrWheelInputBatcher({
    sendNow: (pane, data) => {
      sent.push({ pane: pane.id, data });
      return true;
    },
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: (handle) => cancelled.push(handle),
  });
  return { batcher, sent, frames, cancelled };
}

test("recognizes only complete SGR wheel input sequences", () => {
  assert.equal(isHerdrWheelInput("\x1b[<64;10;5M"), true);
  assert.equal(isHerdrWheelInput("\x1b[<93;10;5M"), true);
  assert.equal(isHerdrWheelInput("\x1b[<0;10;5M"), false);
  assert.equal(isHerdrWheelInput("\x1b[<64;10;5m"), false);
  assert.equal(isHerdrWheelInput("x\x1b[<64;10;5M"), false);
  assert.equal(isHerdrWheelInput("\x1b[<64;10;5M\x1b[<65;10;5M"), false);
});

test("sends the first wheel input immediately and batches the rest of the frame", () => {
  const { batcher, sent, frames } = harness();

  assert.equal(batcher.handle(herdrPane, "\x1b[<64;10;5M"), true);
  assert.equal(batcher.handle(herdrPane, "\x1b[<65;11;6M"), true);
  assert.equal(batcher.handle(herdrPane, "\x1b[<68;12;7M"), true);
  assert.deepEqual(sent, [{ pane: "herdr-pane", data: "\x1b[<64;10;5M" }]);

  frames.shift()(0);
  assert.deepEqual(sent, [
    { pane: "herdr-pane", data: "\x1b[<64;10;5M" },
    { pane: "herdr-pane", data: "\x1b[<65;11;6M\x1b[<68;12;7M" },
  ]);
});

test("flushes pending wheel input before normal input continues", () => {
  const { batcher, sent } = harness();
  const sendNormal = (data) => sent.push({ pane: herdrPane.id, data });

  batcher.handle(herdrPane, "\x1b[<64;10;5M");
  batcher.handle(herdrPane, "\x1b[<65;11;6M");
  assert.equal(batcher.handle(herdrPane, "a"), false);
  sendNormal("a");

  assert.deepEqual(sent, [
    { pane: "herdr-pane", data: "\x1b[<64;10;5M" },
    { pane: "herdr-pane", data: "\x1b[<65;11;6M" },
    { pane: "herdr-pane", data: "a" },
  ]);
});

test("leaves native panes and non-wheel Herdr input on the existing path", () => {
  const { batcher, sent, frames } = harness();

  assert.equal(batcher.handle(nativePane, "\x1b[<64;10;5M"), false);
  assert.equal(batcher.handle(herdrPane, "paste"), false);
  assert.deepEqual(sent, []);
  assert.deepEqual(frames, []);
});

test("clears queued wheel input at disconnect and disposal boundaries", () => {
  const { batcher, sent, frames, cancelled } = harness();

  batcher.handle(herdrPane, "\x1b[<64;10;5M");
  batcher.handle(herdrPane, "\x1b[<65;11;6M");
  batcher.clear(herdrPane);

  assert.deepEqual(cancelled, [1]);
  frames.shift()(0);
  assert.deepEqual(sent, [{ pane: "herdr-pane", data: "\x1b[<64;10;5M" }]);
});

test("falls back when the immediate send is unavailable", () => {
  const frames = [];
  const batcher = createHerdrWheelInputBatcher({
    sendNow: () => false,
    requestFrame: (callback) => {
      frames.push(callback);
      return frames.length;
    },
    cancelFrame: () => {},
  });

  assert.equal(batcher.handle(herdrPane, "\x1b[<64;10;5M"), false);
  assert.deepEqual(frames, []);
});
