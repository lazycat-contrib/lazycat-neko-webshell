import assert from "node:assert/strict";
import test from "node:test";
import { createMobileKeyGestureController } from "./key-gesture-controller.ts";
class Pointer extends Event {
  constructor(type, values = {}) { super(type, { cancelable: true }); Object.assign(this, { pointerId: 1, button: 0, clientX: 10, clientY: 10, isPrimary: true, ...values }); }
}
function setup(repeat = false) {
  const root = new EventTarget(), globalTarget = new EventTarget(), visibilityTarget = new EventTarget();
  const button = {}, sent = [], finished = [], timers = new Map(); let sequence = 0, usable = true;
  const controller = createMobileKeyGestureController({ root, globalTarget, visibilityTarget,
    button: target => target === root ? button : undefined, usable: () => usable,
    inside: (_button, x, y) => x >= 0 && x <= 100 && y >= 0 && y <= 50,
    repeat: () => repeat, start() {}, activate: (_button, repeating) => sent.push(repeating),
    finish: (_button, repeated) => finished.push(repeated),
    setTimer: (callback, delay) => { timers.set(++sequence, { callback, delay }); return sequence; }, clearTimer: id => timers.delete(id),
  });
  return { controller, sent, finished, timers, visibilityTarget, globalTarget, root,
    disable: () => { usable = false; },
    down: values => { globalTarget.dispatchEvent(new Pointer("pointerdown", values)); root.dispatchEvent(new Pointer("pointerdown", values)); },
    event: (type, values) => globalTarget.dispatchEvent(new Pointer(type, values)),
    click: detail => root.dispatchEvent(new Pointer("click", { detail })),
    fire: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); return timer.delay; },
  };
}

test("a tap commits only on release and its physical click cannot duplicate activation", () => {
  const s = setup(); s.down(); assert.deepEqual(s.sent, []);
  s.event("pointerup"); assert.deepEqual(s.sent, [false]);
  s.click(1); assert.deepEqual(s.sent, [false]); s.controller.dispose();
});

test("swipes cancel ordinary/repeat keys before any byte and cannot rearm by moving back", () => {
  for (const repeat of [false, true]) {
    const s = setup(repeat); s.down(); assert.deepEqual(s.sent, []);
    s.event("pointermove", { clientX: 25 }); s.event("pointermove"); s.event("pointerup"); s.click(1);
    assert.deepEqual(s.sent, []); assert.equal(s.timers.size, 0); s.controller.dispose();
  }
});

test("small tap jitter remains valid but release outside the original key is cancelled", () => {
  const s = setup(); s.down(); s.event("pointermove", { clientX: 13, clientY: 13 }); s.event("pointerup", { clientX: 13, clientY: 13 });
  assert.deepEqual(s.sent, [false]);
  s.down({ clientX: 1 }); s.event("pointerup", { clientX: -1 }); assert.deepEqual(s.sent, [false]); s.controller.dispose();
});

test("repeat starts after the hold threshold and movement stops both repeat and release activation", () => {
  const s = setup(true); s.down(); assert.deepEqual(s.sent, []);
  assert.equal(s.fire(), 360); assert.deepEqual(s.sent, [true]);
  assert.equal(s.fire(), 86); assert.deepEqual(s.sent, [true, true]);
  s.event("pointermove", { clientY: 30 }); assert.equal(s.timers.size, 0);
  s.event("pointerup"); s.click(1); assert.deepEqual(s.sent, [true, true]); assert.equal(s.finished.at(-1), true); s.controller.dispose();
});

test("a held repeat key has no extra final release byte; short repeat taps send once", () => {
  const s = setup(true); s.down(); s.event("pointerup"); assert.deepEqual(s.sent, [false]);
  s.down(); s.fire(); s.event("pointerup"); assert.deepEqual(s.sent, [false, true]); assert.equal(s.timers.size, 0); s.controller.dispose();
});

test("cancellation, capture loss, blur, pagehide and visibility changes clear pending holds", () => {
  for (const event of ["pointercancel", "lostpointercapture", "blur", "pagehide", "visibilitychange"]) {
    const s = setup(true); s.down();
    if (event === "visibilitychange") s.visibilityTarget.dispatchEvent(new Event(event)); else s.event(event);
    s.event("pointerup"); s.click(1); assert.deepEqual(s.sent, [], event); assert.equal(s.timers.size, 0, event); s.controller.dispose();
  }
});

test("another finger cancels the complete gesture and disabled targets cannot fire late", () => {
  const s = setup(true); s.down(); s.down({ pointerId: 2 }); s.event("pointerup"); s.event("pointerup", { pointerId: 2 });
  assert.deepEqual(s.sent, []); assert.equal(s.timers.size, 0);
  s.down(); s.disable(); s.fire(); assert.deepEqual(s.sent, []); assert.equal(s.timers.size, 0); s.controller.dispose();
});

test("keyboard/AT clicks still activate without a physical gesture and disposal removes all effects", () => {
  const s = setup(true); s.click(0); assert.deepEqual(s.sent, [false]);
  s.down(); s.controller.dispose(); s.controller.dispose(); assert.equal(s.timers.size, 0);
  s.event("pointerup"); s.click(0); s.down(); assert.deepEqual(s.sent, [false]); assert.equal(s.timers.size, 0);
});


test("scrolling the keyboard cancels a pending repeat without canceling for unrelated page scroll", () => {
  const s = setup(true); s.down(); s.globalTarget.dispatchEvent(new Event("scroll"));
  assert.equal(s.timers.size, 1, "unrelated scroll does not own the key gesture");
  s.root.dispatchEvent(new Event("scroll")); s.event("pointerup"); s.click(1);
  assert.equal(s.timers.size, 0); assert.deepEqual(s.sent, []); s.controller.dispose();
});
