import assert from "node:assert/strict";
import test from "node:test";

import { createMobileTerminalInteractionController } from "./terminal-interaction-controller.ts";

function gesture(overrides = {}) {
  return {
    dx: 0,
    dy: 0,
    elapsed: 100,
    maxDistance: 0,
    scrollLocked: false,
    ...overrides,
  };
}

function pointerEvent(clientX = 0, clientY = 0) {
  const event = new Event("pointerup", { cancelable: true });
  event.clientX = clientX;
  event.clientY = clientY;
  return event;
}

test("hands hardware focus to the newly active pane after a tab swipe", () => {
  const firstPane = { id: "first" };
  const secondPane = { id: "second" };
  let activePane = firstPane;
  const events = [];
  const controller = createMobileTerminalInteractionController({
    activePane: () => activePane,
    activateAdjacentTab: (direction) => {
      events.push(`activate:${direction}`);
      activePane = secondPane;
    },
    dismissKeyboardAfterGesture: (pane) => events.push(`dismiss:${pane.id}`),
    findPaneById: (id) => id === firstPane.id ? firstPane : undefined,
    restoreKeyboard: () => events.push("restore"),
    showKeyboard: () => events.push("show"),
  });
  const event = pointerEvent();

  controller.handleGestureEnd(firstPane.id, event, gesture({
    dx: -90,
    maxDistance: 90,
  }), false);

  assert.deepEqual(events, ["activate:1", "dismiss:second"]);
  assert.equal(event.defaultPrevented, true);
});

test("dismisses the keyboard for a consumed vertical scroll", () => {
  const pane = { id: "scroll" };
  const events = [];
  const controller = createMobileTerminalInteractionController({
    activePane: () => pane,
    activateAdjacentTab: () => events.push("activate"),
    dismissKeyboardAfterGesture: (target) => events.push(`dismiss:${target.id}`),
    findPaneById: () => pane,
    restoreKeyboard: () => events.push("restore"),
    showKeyboard: () => events.push("show"),
  });

  controller.handleGestureEnd(pane.id, pointerEvent(), gesture({
    dy: 10,
    maxDistance: 10,
    scrollLocked: true,
  }), false);

  assert.deepEqual(events, ["dismiss:scroll"]);
});

test("does not switch tabs after a gesture already consumed vertical scroll", () => {
  const pane = { id: "mixed-axis" };
  const events = [];
  const controller = createMobileTerminalInteractionController({
    activePane: () => pane,
    activateAdjacentTab: () => events.push("activate"),
    dismissKeyboardAfterGesture: () => events.push("dismiss"),
    findPaneById: () => pane,
    restoreKeyboard: () => events.push("restore"),
    showKeyboard: () => events.push("show"),
  });

  controller.handleGestureEnd(pane.id, pointerEvent(), gesture({
    dx: 90,
    dy: 5,
    maxDistance: 90,
    scrollLocked: true,
  }), false);

  assert.deepEqual(events, ["dismiss"]);
});

test("restores on one tap and explicitly opens on the second tap", () => {
  const pane = { id: "double-tap" };
  const events = [];
  const controller = createMobileTerminalInteractionController({
    activePane: () => pane,
    activateAdjacentTab: () => events.push("activate"),
    dismissKeyboardAfterGesture: () => events.push("dismiss"),
    findPaneById: () => pane,
    restoreKeyboard: () => events.push("restore"),
    showKeyboard: () => events.push("show"),
  });

  controller.handleGestureEnd(pane.id, pointerEvent(20, 20), gesture(), false);
  const second = pointerEvent(21, 20);
  controller.handleGestureEnd(pane.id, second, gesture({ dx: 1, maxDistance: 1 }), false);

  assert.deepEqual(events, ["restore", "show"]);
  assert.equal(second.defaultPrevented, true);
});

test("a scroll between taps resets the double-tap chain", () => {
  const pane = { id: "interrupted-double-tap" };
  const events = [];
  const controller = createMobileTerminalInteractionController({
    activePane: () => pane,
    activateAdjacentTab: () => events.push("activate"),
    dismissKeyboardAfterGesture: () => events.push("dismiss"),
    findPaneById: () => pane,
    restoreKeyboard: () => events.push("restore"),
    showKeyboard: () => events.push("show"),
  });

  controller.handleGestureEnd(pane.id, pointerEvent(20, 20), gesture(), false);
  controller.handleGestureEnd(pane.id, pointerEvent(20, 30), gesture({
    dy: 10,
    maxDistance: 10,
    scrollLocked: true,
  }), false);
  controller.handleGestureEnd(pane.id, pointerEvent(21, 20), gesture({
    dx: 1,
    maxDistance: 1,
  }), false);

  assert.deepEqual(events, ["restore", "dismiss", "restore"]);
});
