import assert from "node:assert/strict";
import test from "node:test";

import { installMobileKeyboardReorderGesture } from "./keyboard-reorder-gesture.ts";

function setup() {
  const listeners = new Map();
  const root = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    removeEventListener: (name) => listeners.delete(name),
  };
  const timers = new Map();
  const frames = new Map();
  let next = 0;
  const scheduler = {
    setTimeout: (callback, delay) => { const id = ++next; timers.set(id, { callback, delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (callback) => { const id = ++next; frames.set(id, callback); return id; },
    cancelAnimationFrame: (id) => frames.delete(id),
  };
  const classes = () => {
    const values = new Set();
    return { add: (value) => values.add(value), remove: (...items) => items.forEach((value) => values.delete(value)), contains: (value) => values.has(value) };
  };
  const rows = ["first", "second", "third"].map((id, index) => ({
    dataset: { mobileLayoutKey: id }, classList: classes(),
    closest: () => rows[index],
    getBoundingClientRect: () => ({ top: index * 40, bottom: index * 40 + 40 }),
  }));
  const list = {
    contains: (row) => rows.includes(row),
    querySelectorAll: (selector) => selector === "[data-mobile-layout-key]"
      ? rows : rows.filter((row) => selector.split(", ").some((name) => row.classList.contains(name.slice(1)))),
    setPointerCapture() {}, hasPointerCapture: () => false,
  };
  const scrollHost = {
    scrollTop: 0, clientHeight: 100, scrollHeight: 300,
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
  };
  let hit = rows[0];
  const moves = [];
  const controller = installMobileKeyboardReorderGesture({
    root, list, scrollHost, scheduler,
    hitTest: () => hit,
    windowTarget: new EventTarget(), visibilityTarget: new EventTarget(),
    move: (from, to) => moves.push([from, to]),
  });
  function pointer(type, row = rows[0], values = {}) {
    const event = {
      target: row, pointerId: 1, pointerType: "touch", button: 0,
      clientX: 10, clientY: 10, prevented: false,
      preventDefault() { this.prevented = true; }, ...values,
    };
    listeners.get(type)?.(event);
    return event;
  }
  return { pointer, rows, timers, frames, scrollHost, moves, controller,
    setHit: (row) => { hit = row; },
    hold: () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.callback(); return timer.delay; },
    frame: () => { const [id, callback] = frames.entries().next().value; frames.delete(id); callback(); },
    click: (values = {}) => {
      const event = { detail: 1, clientX: 10, clientY: 10, prevented: false,
        preventDefault() { this.prevented = true; }, stopImmediatePropagation() {}, ...values };
      listeners.get("click")?.(event);
      return event;
    },
  };
}

test("short taps keep their edit click; a swipe scrolls without changing order", () => {
  const s = setup();
  s.pointer("pointerdown");
  s.pointer("pointerup");
  assert.equal(s.click().prevented, false);
  assert.deepEqual(s.moves, []);

  s.pointer("pointerdown", s.rows[0], { clientY: 70 });
  s.pointer("pointermove", s.rows[0], { clientY: 45 });
  assert.equal(s.timers.size, 0);
  assert.equal(s.scrollHost.scrollTop, 25);
  s.pointer("pointerup", s.rows[0], { clientY: 45 });
  assert.equal(s.click({ clientY: 45 }).prevented, true);
  assert.deepEqual(s.moves, []);
  s.controller.dispose();
});

test("long press from the row moves its key, suppresses the following click, and edge scrolls", () => {
  const s = setup();
  s.pointer("pointerdown");
  assert.equal(s.hold(), 380);
  s.setHit(s.rows[2]);
  s.pointer("pointermove", s.rows[0], { clientY: 95 });
  assert.ok(s.frames.size > 0);
  s.frame();
  assert.ok(s.scrollHost.scrollTop > 0);
  s.pointer("pointerup", s.rows[0], { clientY: 95 });
  assert.deepEqual(s.moves, [["first", "third"]]);
  assert.equal(s.click({ clientY: 95 }).prevented, true);
  s.controller.dispose();
});

test("a second finger scrolls while the original key remains selected; cancellation never reorders", () => {
  const s = setup();
  s.pointer("pointerdown");
  s.hold();
  s.pointer("pointerdown", s.rows[1], { pointerId: 2, clientY: 80 });
  s.setHit(s.rows[1]);
  s.pointer("pointermove", s.rows[1], { pointerId: 2, clientY: 50 });
  assert.equal(s.scrollHost.scrollTop, 30);
  s.pointer("pointerup", s.rows[1], { pointerId: 2, clientY: 50 });
  s.pointer("pointermove", s.rows[0], { clientY: 60 });
  s.pointer("pointerup", s.rows[0], { clientY: 60 });
  assert.deepEqual(s.moves, [["first", "second"]]);

  s.pointer("pointerdown");
  s.hold();
  s.pointer("pointercancel");
  assert.deepEqual(s.moves, [["first", "second"]]);
  s.controller.dispose();
});
