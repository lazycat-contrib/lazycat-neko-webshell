import assert from "node:assert/strict";
import test from "node:test";

import { installTouchKeyboardReadOnlyGuard } from "./touch-keyboard-guard.ts";
import { isMobileTerminalTapGesture } from "./terminal-gestures.ts";

function onNonTapGesture(callback) {
  return (_event, gesture, cancelled) => {
    if (cancelled || !isMobileTerminalTapGesture(gesture)) callback();
  };
}

class TouchPointerEvent extends Event {
  constructor(type, pointerId, pointerType = "touch", clientX = 0, clientY = 0) {
    super(type);
    this.pointerId = pointerId;
    this.pointerType = pointerType;
    this.clientX = clientX;
    this.clientY = clientY;
  }
}

test("restores the IME input when a touch ends outside the terminal pane", () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 0.8,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 7, "touch", 10, 10));
  assert.equal(input.readOnly, true);

  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 7, "touch", 20, 20));
  assert.equal(input.readOnly, false);
});

test("keeps the IME readonly through the end of a vertical scroll gesture", async () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 0.8,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 11, "touch", 40, 120));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 11, "touch", 42, 80));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 11, "touch", 42, 80));

  assert.equal(input.readOnly, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.readOnly, false);
});

test("ends a scroll gesture before restoring the editable IME", async () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };
  const events = [];

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    onGestureEnd: onNonTapGesture(() => events.push(`release:${input.readOnly}`)),
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 0.8,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 12, "touch", 40, 120));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 12, "touch", 42, 80));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 12, "touch", 42, 80));

  assert.deepEqual(events, ["release:true"]);
  assert.equal(input.readOnly, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.readOnly, false);
});

test("treats a horizontal swipe as a non-tap before restoring the IME", async () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };
  const events = [];

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    onGestureEnd: onNonTapGesture(() => events.push("release")),
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 1.1,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 13, "touch", 120, 40));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 13, "touch", 80, 42));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 13, "touch", 80, 42));

  assert.deepEqual(events, ["release"]);
  assert.equal(input.readOnly, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.readOnly, false);
});

test("uses the terminal tap threshold for small touch movement", () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };
  const events = [];

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    onGestureEnd: onNonTapGesture(() => events.push("release")),
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 1.1,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 14, "touch", 20, 20));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 14, "touch", 30, 20));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 14, "touch", 30, 20));

  assert.deepEqual(events, []);
  assert.equal(input.readOnly, false);
});

test("treats a small vertical scroll lock as non-tap", async () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };
  const events = [];

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    onGestureEnd: onNonTapGesture(() => events.push("release")),
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 1.1,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 17, "touch", 20, 20));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 17, "touch", 20, 30));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 17, "touch", 20, 30));

  assert.deepEqual(events, ["release"]);
  assert.equal(input.readOnly, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.readOnly, false);
});

test("keeps tracking after a small vertical move locks scrolling", async () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };
  const events = [];

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    onGestureEnd: onNonTapGesture(() => events.push("release")),
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 1.1,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 15, "touch", 0, 0));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 15, "touch", 0, 10));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 15, "touch", 0, 50));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 15, "touch", 0, 50));

  assert.deepEqual(events, ["release"]);
  assert.equal(input.readOnly, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.readOnly, false);
});

test("keeps a drag non-tap after it returns near its origin", async () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };
  const events = [];

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    onGestureEnd: onNonTapGesture(() => events.push("release")),
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 1.1,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 16, "touch", 0, 0));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 16, "touch", 0, 50));
  pane.dispatchEvent(new TouchPointerEvent("pointermove", 16, "touch", 0, 2));
  globalTarget.dispatchEvent(new TouchPointerEvent("pointerup", 16, "touch", 0, 2));

  assert.deepEqual(events, ["release"]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(input.readOnly, false);
});

test("restores stale readonly state before starting the next touch", () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const firstInput = { readOnly: false };
  const secondInput = { readOnly: false };
  let currentInput = firstInput;

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => currentInput,
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 0.8,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 1));
  currentInput = secondInput;
  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 2));

  assert.equal(firstInput.readOnly, false);
  assert.equal(secondInput.readOnly, true);
});

test("restores the IME input when the page loses visibility", () => {
  const pane = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  const input = { readOnly: false };

  installTouchKeyboardReadOnlyGuard({
    pane,
    globalTarget,
    visibilityTarget,
    input: () => input,
    scrollLockThresholdPx: 8,
    scrollAxisRatio: 0.8,
  });

  pane.dispatchEvent(new TouchPointerEvent("pointerdown", 3));
  visibilityTarget.dispatchEvent(new Event("visibilitychange"));

  assert.equal(input.readOnly, false);
});
