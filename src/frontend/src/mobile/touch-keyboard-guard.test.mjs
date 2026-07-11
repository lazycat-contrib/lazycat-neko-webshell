import assert from "node:assert/strict";
import test from "node:test";

import { installTouchKeyboardReadOnlyGuard } from "./touch-keyboard-guard.ts";

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
