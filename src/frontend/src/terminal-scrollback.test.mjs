import assert from "node:assert/strict";
import test from "node:test";

import { installPaneScrollbackFallback } from "./terminal-scrollback.ts";

class TestPointerEvent extends Event {
  constructor(type, init) {
    super(type, { bubbles: true, cancelable: true });
    Object.assign(this, init);
  }
}

class TestWheelEvent extends Event {
  static DOM_DELTA_PIXEL = 0;

  constructor(type, init) {
    super(type, { bubbles: init.bubbles, cancelable: init.cancelable });
    const { bubbles: _bubbles, cancelable: _cancelable, ...properties } = init;
    Object.assign(this, properties);
  }
}

class TestClassList {
  toggle() {}
}

class TestMount extends EventTarget {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.classList = new TestClassList();
  }

  querySelector(selector) {
    if (selector === ".pane-canvas") return this.canvas;
    return null;
  }
}

test("touch scroll dispatches wheel input when mobile Restty has no native scroll host", () => {
  const originalWheelEvent = globalThis.WheelEvent;
  const originalGetComputedStyle = globalThis.getComputedStyle;
  globalThis.WheelEvent = TestWheelEvent;
  globalThis.getComputedStyle = () => ({
    fontSize: "14px",
    lineHeight: "18px",
    getPropertyValue: (name) => name === "--term-line-height" ? "18px" : "14px",
  });

  try {
    const canvas = new EventTarget();
    const mount = new TestMount(canvas);
    const wheelDeltas = [];
    canvas.addEventListener("wheel", (event) => wheelDeltas.push(event.deltaY));
    const pane = {
      mount,
      sessionBackend: "webshell",
      term: {
        restty: {
          getMouseStatus: () => ({ active: false }),
        },
      },
    };

    installPaneScrollbackFallback(pane, { touchSelectionMode: () => "long-press" });
    mount.dispatchEvent(new TestPointerEvent("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      clientX: 20,
      clientY: 100,
      shiftKey: false,
    }));
    mount.dispatchEvent(new TestPointerEvent("pointermove", {
      pointerId: 7,
      pointerType: "touch",
      clientX: 20,
      clientY: 60,
      shiftKey: false,
      ctrlKey: false,
      altKey: false,
      metaKey: false,
    }));

    assert.deepEqual(wheelDeltas, [18, 18]);
  } finally {
    globalThis.WheelEvent = originalWheelEvent;
    globalThis.getComputedStyle = originalGetComputedStyle;
  }
});
