import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalFocusBoundary } from "./terminal-focus-boundary.ts";

function setup() {
  const root = new EventTarget();
  let canvas = new EventTarget();
  const input = new EventTarget();
  const tasks = [];
  const boundary = createTerminalFocusBoundary({ root, canvas: () => canvas, input, defer: fn => tasks.push(fn) });
  function blur(target, relatedTarget) {
    const event = new Event("blur");
    Object.defineProperties(event, { target: { value: target }, relatedTarget: { value: relatedTarget } });
    root.dispatchEvent(event);
  }
  return { root, input, tasks, boundary, blur, get canvas() { return canvas; }, replaceCanvas() { canvas = new EventTarget(); } };
}

test("internal canvas to IME focus movement cannot cancel a TUI mouse press", () => {
  const f = setup();
  const wire = ["\x1b[<0;4;4M"];
  f.blur(f.canvas, f.input);
  for (const text of ["\x1b[O", "\x1b[I", "\x1b[<0;4;4m"]) {
    if (!f.boundary.suppress(text, "program")) wire.push(text);
  }
  assert.deepEqual(wire, ["\x1b[<0;4;4M", "\x1b[I", "\x1b[<0;4;4m"]);
  f.tasks.shift()();
  assert.equal(f.boundary.suppress("\x1b[O", "program"), false, "later genuine focus loss is not suppressed");
  f.boundary.dispose();
});

test("moving focus to another control, another terminal, or the window still reports loss", () => {
  const f = setup();
  for (const destination of [new EventTarget(), null]) {
    f.blur(f.canvas, f.input);
    f.blur(f.canvas, destination);
    assert.equal(f.boundary.suppress("\x1b[O", "program"), false);
  }
  f.boundary.dispose();
});

test("only generated focus-out is filtered, never pasted/key input or other escape sequences", () => {
  const f = setup();
  f.blur(f.input, f.canvas);
  for (const source of ["key", "pty", "paste"]) assert.equal(f.boundary.suppress("\x1b[O", source), false);
  for (const text of ["\x1b[I", "\x1b[<0;3;4m", "\x1b[Otext", "text"]) {
    assert.equal(f.boundary.suppress(text, "program"), false);
  }
  f.boundary.dispose();
});

test("nested DOM focus transitions cannot be cleared by an older deferred callback", () => {
  const f = setup();
  f.blur(f.canvas, null);
  f.blur(f.canvas, f.input);
  f.tasks.shift()();
  assert.equal(f.boundary.suppress("\x1b[O", "program"), true);
  f.tasks.shift()();
  assert.equal(f.boundary.suppress("\x1b[O", "program"), false);
  f.boundary.dispose();
});

test("replacement canvas and idempotent disposal retain the correct ownership boundary", () => {
  const f = setup();
  const old = f.canvas;
  f.replaceCanvas();
  f.blur(old, f.input);
  assert.equal(f.boundary.suppress("\x1b[O", "program"), false);
  f.blur(f.canvas, f.input);
  assert.equal(f.boundary.suppress("\x1b[O", "program"), true);
  f.boundary.dispose(); f.boundary.dispose();
  f.blur(f.canvas, f.input);
  while (f.tasks.length) f.tasks.shift()();
  assert.equal(f.boundary.suppress("\x1b[O", "program"), false);
});
