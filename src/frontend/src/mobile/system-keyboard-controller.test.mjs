import assert from "node:assert/strict";
import test from "node:test";

import { createMobileSystemKeyboardController } from "./system-keyboard-controller.ts";

test("closes the system keyboard mode when the active pane changes", () => {
  const firstPane = { id: "first" };
  const secondPane = { id: "second" };
  const events = [];
  let pane = firstPane;
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: (target) => events.push(`dismiss:${target.id}`),
    enableAllPanes: () => events.push("enable-all"),
    focusHardwarePane: (target) => events.push(`hardware:${target.id}`),
    focusPane: (target) => {
      events.push(`focus:${target.id}`);
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.preserveState();
  assert.deepEqual(events, ["dismiss:first", "hardware:first"]);

  controller.restoreState();
  assert.deepEqual(events, [
    "dismiss:first",
    "hardware:first",
    "dismiss:first",
    "hardware:first",
    "update:false",
  ]);

  events.length = 0;
  controller.toggle();
  assert.deepEqual(events, ["focus:first", "update:true"]);

  controller.sync(true);
  events.length = 0;
  controller.preserveState();
  assert.deepEqual(events, []);

  pane = secondPane;
  controller.restoreState();
  assert.deepEqual(events, [
    "dismiss:first",
    "dismiss:second",
    "hardware:second",
    "update:false",
  ]);

  events.length = 0;
  controller.sync(false);
  assert.deepEqual(events, ["update:false"]);

  events.length = 0;
  controller.toggle();
  assert.deepEqual(events, ["focus:second", "update:true"]);
});

test("explicit show enables the keyboard even when an overlay keyboard does not resize the viewport", () => {
  const pane = { id: "overlay" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => events.push("enable-all"),
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  controller.toggle();

  assert.deepEqual(events, ["focus", "update:true", "dismiss", "hardware", "update:false"]);
});

test("turns off the enabled mode when a docked keyboard closes through Android controls", () => {
  const pane = { id: "docked" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => events.push("enable-all"),
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  controller.sync(true);
  controller.sync(false);
  controller.toggle();

  assert.deepEqual(events, [
    "focus",
    "update:true",
    "update:true",
    "dismiss",
    "hardware",
    "update:false",
    "focus",
    "update:true",
  ]);
});

test("waits for the docked keyboard to close before allowing it to reopen", () => {
  const pane = { id: "rapid" };
  const states = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => {},
    enableAllPanes: () => {},
    focusHardwarePane: () => {},
    focusPane: () => true,
    updateToggle: (next) => states.push(next),
  });

  controller.show(pane);
  controller.sync(true);
  controller.toggle();
  controller.toggle();
  controller.sync(false);
  assert.equal(states.at(-1), false);

  controller.toggle();
  assert.equal(states.at(-1), true);
});

test("does not reopen an unobservable overlay keyboard after the active pane changes", () => {
  const firstPane = { id: "first" };
  const secondPane = { id: "second" };
  let pane = firstPane;
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: (target) => events.push(`dismiss:${target.id}`),
    enableAllPanes: () => events.push("enable-all"),
    focusHardwarePane: (target) => events.push(`hardware:${target.id}`),
    focusPane: (target) => {
      events.push(`focus:${target.id}`);
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(firstPane);
  pane = secondPane;
  controller.restoreState();

  assert.deepEqual(events, [
    "focus:first",
    "update:true",
    "dismiss:first",
    "dismiss:second",
    "hardware:second",
    "update:false",
  ]);
});

test("keeps the toggle off when the pane IME cannot be focused yet", () => {
  const pane = { id: "unmounted" };
  const states = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => {},
    enableAllPanes: () => {},
    focusHardwarePane: () => {},
    focusPane: () => false,
    updateToggle: (next) => states.push(next),
  });

  controller.show(pane);

  assert.deepEqual(states, [false]);
});

test("releases every pane IME when mobile controls switch to desktop", () => {
  const pane = { id: "responsive" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => events.push("enable-all"),
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => true,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  controller.sync(false, false);

  assert.deepEqual(events, [
    "update:true",
    "enable-all",
    "update:false",
  ]);

  events.length = 0;
  controller.restoreState();
  controller.preserveState();
  controller.show(pane);
  controller.toggle();

  assert.deepEqual(events, []);
});

test("closes an overlay keyboard mode when the active pane terminal remounts", () => {
  const pane = { id: "remounted" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: (target) => events.push(`dismiss:${target.id}`),
    enableAllPanes: () => {},
    focusHardwarePane: (target) => events.push(`hardware:${target.id}`),
    focusPane: (target) => {
      events.push(`focus:${target.id}`);
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  events.length = 0;
  controller.resetMountedPane(pane);

  assert.deepEqual(events, [
    "dismiss:remounted",
    "hardware:remounted",
    "update:false",
  ]);
});

test("clears an overlay keyboard state after the last pane disappears", () => {
  const pane = { id: "last" };
  let activePane = pane;
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => activePane,
    dismissPane: (target) => events.push(`dismiss:${target.id}`),
    enableAllPanes: () => {},
    focusHardwarePane: () => {},
    focusPane: () => true,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  activePane = undefined;
  controller.restoreState();

  assert.deepEqual(events, ["update:true", "dismiss:last", "update:false"]);
});
