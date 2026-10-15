import assert from "node:assert/strict";
import test from "node:test";

import { installMobileKeyboardPageSwipe } from "./keyboard-page-swipe.ts";

class TouchPointer extends Event {
  constructor(type, values = {}) {
    super(type, { bubbles: true });
    Object.assign(this, { pointerId: 1, pointerType: "touch", isPrimary: true, clientX: 160, clientY: 200, ...values });
  }
}

function setup() {
  const root = new EventTarget();
  let page = "typing";
  const activated = [];
  const dispose = installMobileKeyboardPageSwipe({
    root,
    globalTarget: root,
    activePage: () => page,
    activatePage: (next) => { page = next; activated.push(next); },
  });
  return { root, activated, dispose, page: () => page,
    event: (type, values) => root.dispatchEvent(new TouchPointer(type, values)),
  };
}

test("horizontal swipes switch only between typing and function pages", () => {
  const s = setup();
  s.event("pointerdown");
  s.event("pointermove", { clientX: 70, clientY: 205 });
  s.event("pointerup", { clientX: 70, clientY: 205 });
  assert.equal(s.page(), "function");
  s.event("pointerdown", { clientX: 70 });
  s.event("pointerup", { clientX: 170 });
  assert.deepEqual(s.activated, ["function", "typing"]);
  s.dispose();
});

test("vertical pan, short movement, cancel, and another finger do not switch pages", () => {
  const s = setup();
  s.event("pointerdown");
  s.event("pointerup", { clientX: 105, clientY: 80 });
  s.event("pointerdown");
  s.event("pointerup", { clientX: 130 });
  s.event("pointerdown");
  s.event("pointercancel");
  s.event("pointerup", { clientX: 50 });
  s.event("pointerdown");
  s.event("pointerdown", { pointerId: 2, isPrimary: false });
  s.event("pointerup", { clientX: 50 });
  assert.deepEqual(s.activated, []);
  s.dispose();
});
