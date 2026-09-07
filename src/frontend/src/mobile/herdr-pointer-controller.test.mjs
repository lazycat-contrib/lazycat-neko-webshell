import assert from "node:assert/strict";
import test from "node:test";
import { dispatchHerdrTap, installHerdrPointerController } from "./herdr-pointer-controller.ts";

function setup() {
  const root = new EventTarget();
  const globalTarget = new EventTarget();
  const visibilityTarget = new EventTarget();
  let canvas = new EventTarget();
  let connection = {};
  let enabled = true;
  let ready = true;
  let now = 0;
  const taps = [];
  const dispose = installHerdrPointerController({
    root, globalTarget, visibilityTarget, canvas: () => canvas,
    enabled: () => enabled, connection: () => connection,
    ready: () => ready,
    moveThresholdPx: 6, now: () => now,
    sendTap: (target, event) => taps.push({ target, x: event.clientX, y: event.clientY }),
  });
  function event(type, options = {}, target = root) {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: 1, pointerType: "touch", isPrimary: true,
      button: 0, clientX: 30, clientY: 80, shiftKey: false, ...options });
    Object.defineProperty(event, "target", { value: canvas });
    target.dispatchEvent(event);
    return event;
  }
  return { root, globalTarget, visibilityTarget, taps, event, dispose,
    setTime: (value) => { now = value; },
    replaceCanvas: () => { canvas = new EventTarget(); },
    reconnect: () => { connection = {}; },
    disable: () => { enabled = false; },
    setReady: (value) => { ready = value; },
  };
}

test("Herdr touch waits for release and sends one complete tap", () => {
  const f = setup();
  f.event("pointerdown");
  assert.equal(f.taps.length, 0);
  f.event("pointerup");
  assert.equal(f.taps.length, 1);
  assert.equal(f.taps[0].x, 30);
  f.event("pointerup");
  assert.equal(f.taps.length, 1);
  f.dispose();
});

test("scrolls, swipes, long presses and a moved release never become clicks", () => {
  for (const mode of ["scroll", "swipe", "long-press", "moved-release"]) {
    const f = setup();
    f.event("pointerdown");
    if (mode === "scroll") f.event("pointermove", { clientY: 100 });
    if (mode === "swipe") f.event("pointermove", { clientX: 120 });
    if (mode === "long-press") f.setTime(450);
    f.event("pointerup", mode === "moved-release" ? { clientY: 90 } : {});
    assert.equal(f.taps.length, 0, mode);
    f.dispose();
  }
});

test("native mouse and Shift selection are untouched", () => {
  for (const options of [{ pointerType: "mouse" }, { shiftKey: true }]) {
    const f = setup();
    const down = f.event("pointerdown", options);
    f.event("pointerup", options);
    assert.equal(down.cancelBubble, false);
    assert.equal(down.defaultPrevented, false);
    assert.equal(f.taps.length, 0);
    f.dispose();
  }
});

test("second touch cancels a pending tap", () => {
  const f = setup();
  f.event("pointerdown");
  f.event("pointerdown", { pointerId: 2, isPrimary: false });
  f.event("pointerup");
  assert.equal(f.taps.length, 0);
  f.dispose();
});

test("a second touch in another pane cancels the first pane's tap", () => {
  const f = setup();
  f.event("pointerdown");
  f.event("pointerdown", { pointerId: 2, isPrimary: false }, f.globalTarget);
  f.event("pointerup");
  assert.equal(f.taps.length, 0);
  f.dispose();
});

test("cancellation, capture loss, external release, blur and visibility clear a touch", () => {
  for (const type of ["pointercancel", "lostpointercapture", "pointerup", "blur", "visibilitychange"]) {
    const f = setup();
    f.event("pointerdown");
    f.event(type, {}, type === "visibilitychange" ? f.visibilityTarget : f.globalTarget);
    f.event("pointerup");
    assert.equal(f.taps.length, 0, type);
    f.dispose();
  }
});

test("a keyboard-claimed tap, replaced connection/canvas or disabled pane cannot click", () => {
  for (const mode of ["keyboard", "connection", "canvas", "disabled"]) {
    const f = setup();
    f.event("pointerdown");
    if (mode === "keyboard") f.root.addEventListener("pointerup", (e) => e.preventDefault(), { capture: true });
    if (mode === "connection") f.reconnect();
    if (mode === "canvas") f.replaceCanvas();
    if (mode === "disabled") f.disable();
    // A real keyboard claim runs at window capture before the pane handler.
    if (mode === "keyboard") {
      const e = new Event("pointerup", { cancelable: true });
      Object.assign(e, { pointerId: 1, pointerType: "touch", clientX: 30, clientY: 80 });
      e.preventDefault();
      f.root.dispatchEvent(e);
    } else f.event("pointerup");
    assert.equal(f.taps.length, 0, mode);
    f.dispose();
  }
});

test("dispose is repeatable and removes event handlers", () => {
  const f = setup();
  f.event("pointerdown");
  f.dispose(); f.dispose();
  f.event("pointerup");
  f.event("pointerdown"); f.event("pointerup");
  assert.equal(f.taps.length, 0);
});

test("replay keeps intercepting touch so no unmatched press can be buffered", () => {
  const f = setup();
  f.setReady(false);
  const down = f.event("pointerdown");
  assert.equal(down.cancelBubble, true);
  f.setReady(true);
  f.event("pointerup");
  assert.equal(f.taps.length, 0, "a touch that began during replay cannot click afterward");
  f.event("pointerdown");
  f.setReady(false);
  f.event("pointerup");
  assert.equal(f.taps.length, 0, "replay beginning during a touch cancels it");
  f.dispose();
});

test("tap uses Restty's native mouse encoder with original coordinates and modifiers", (t) => {
  const previous = globalThis.PointerEvent;
  globalThis.PointerEvent = class extends Event {
    constructor(type, options) {
      super(type, options);
      const { bubbles, cancelable, ...fields } = options;
      Object.assign(this, fields);
    }
  };
  t.after(() => { globalThis.PointerEvent = previous; });
  const canvas = new EventTarget();
  const seen = [];
  for (const type of ["pointerdown", "pointerup"]) canvas.addEventListener(type, e => seen.push({
    type: e.type, pointerType: e.pointerType, buttons: e.buttons,
    clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey,
  }));
  dispatchHerdrTap(canvas, { pointerId: 8, clientX: 42, clientY: 107, ctrlKey: true });
  assert.deepEqual(seen, [
    { type: "pointerdown", pointerType: "mouse", buttons: 1, clientX: 42, clientY: 107, ctrlKey: true },
    { type: "pointerup", pointerType: "mouse", buttons: 0, clientX: 42, clientY: 107, ctrlKey: true },
  ]);
});
