import assert from "node:assert/strict";
import test from "node:test";

import { createMobileSystemKeyboardController } from "./system-keyboard-controller.ts";

test("keeps historical automatic keyboard focus when prevention is disabled", () => {
  const pane = { id: "compat" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => events.push("enable-all"),
    focusAutomaticPane: () => {
      events.push("automatic-focus");
      return true;
    },
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("explicit-focus");
      return true;
    },
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.restoreState();
  assert.equal(controller.resetMountedPane(pane), false);

  assert.deepEqual(events, ["automatic-focus", "update:false"]);
});

test("keeps an already-focused automatic keyboard stable after shortcuts", () => {
  const pane = { id: "automatic-focused" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusAutomaticPane: () => {
      events.push("refocus");
      return true;
    },
    focusHardwarePane: () => {},
    focusPane: () => true,
    isPaneKeyboardFocused: () => true,
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.preserveState()();

  assert.deepEqual(events, ["update:false"]);
});

test("keeps a closed system keyboard unfocused after a bottom keyboard shortcut", () => {
  const pane = { id: "shortcut-closed" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusAutomaticPane: () => {
      events.push("automatic-focus");
      return true;
    },
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => true,
    isPaneKeyboardFocused: () => false,
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  const restore = controller.preserveState();
  assert.deepEqual(events, ["dismiss", "hardware"]);

  events.length = 0;
  restore();
  assert.deepEqual(events, ["dismiss", "hardware", "update:false"]);
});

test("does not let an older shortcut restore over a newer keyboard choice", () => {
  const pane = { id: "overlapping-shortcuts" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    isPaneKeyboardFocused: () => false,
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  const restoreOlderShortcut = controller.preserveState();
  controller.preserveState();
  controller.show(pane);
  events.length = 0;

  restoreOlderShortcut();

  assert.deepEqual(events, []);
});

test("does not restore a shortcut after viewport state changes", () => {
  const pane = { id: "viewport-change" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  controller.sync(true);
  const restoreShortcut = controller.preserveState();
  controller.sync(false);
  events.length = 0;

  restoreShortcut();

  assert.deepEqual(events, []);
});

test("keeps the next bottom key closed after toggling the system keyboard off", () => {
  const pane = { id: "toggle-then-shortcut" };
  const events = [];
  let focused = false;
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => {
      events.push("dismiss");
    },
    enableAllPanes: () => {},
    focusAutomaticPane: () => {
      focused = true;
      events.push("automatic-focus");
      return true;
    },
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      focused = true;
      events.push("focus");
      return true;
    },
    isPaneKeyboardFocused: () => focused,
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  controller.sync(true);
  controller.toggle();
  events.length = 0;

  controller.preserveState()();

  assert.deepEqual(events, ["dismiss", "hardware", "dismiss", "hardware", "update:false"]);
});

test("does not activate the toggle when an input opens the keyboard automatically", () => {
  const pane = { id: "automatic" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.sync(true);
  controller.toggle();

  assert.deepEqual(events, [
    "update:false",
    "dismiss",
    "hardware",
    "update:false",
  ]);
});

test("closes an automatically focused overlay keyboard with one toggle", () => {
  const pane = { id: "automatic-overlay" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    isPaneKeyboardFocused: () => true,
    preventAutoOpen: () => false,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.toggle();

  assert.deepEqual(events, ["dismiss", "hardware", "update:false"]);
});

test("applies keyboard prevention only after the preference is enabled", () => {
  const pane = { id: "preference" };
  let preventAutoOpen = false;
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => events.push("enable-all"),
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => true,
    preventAutoOpen: () => preventAutoOpen,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.applyPreference();
  preventAutoOpen = true;
  controller.applyPreference();

  assert.deepEqual(events, [
    "enable-all",
    "update:false",
    "dismiss",
    "hardware",
    "update:false",
  ]);
});

test("reasserts the closed keyboard state on the pane before a terminal touch", () => {
  const activePane = { id: "active" };
  const touchedPane = { id: "touched" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => activePane,
    dismissPane: (pane) => events.push(`dismiss:${pane.id}`),
    enableAllPanes: () => {},
    focusHardwarePane: (pane) => events.push(`hardware:${pane.id}`),
    focusPane: (pane) => {
      events.push(`focus:${pane.id}`);
      return true;
    },
    preventAutoOpen: () => true,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.preservePaneState(touchedPane);
  assert.deepEqual(events, ["dismiss:touched", "hardware:touched"]);

  events.length = 0;
  controller.show(touchedPane);
  events.length = 0;
  controller.preservePaneState(touchedPane);
  assert.deepEqual(events, []);
});

test("does not preserve unexpected IME focus while auto-open prevention is enabled", () => {
  const pane = { id: "unexpected-focus" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => true,
    isPaneKeyboardFocused: () => true,
    preventAutoOpen: () => true,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.sync(true);
  events.length = 0;

  controller.preserveState()();

  assert.deepEqual(events, ["dismiss", "hardware", "dismiss", "hardware", "update:false"]);
});

test("dismisses keyboard focus when a terminal scroll gesture finishes", () => {
  const pane = { id: "scrolling" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      events.push("focus");
      return true;
    },
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  events.length = 0;
  controller.dismissAfterGesture(pane);
  assert.deepEqual(events, ["dismiss", "hardware", "update:false"]);

  events.length = 0;
  controller.toggle();
  assert.deepEqual(events, ["focus", "update:true"]);
});

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

test("does not reopen a floating keyboard after its input has lost focus", () => {
  const pane = { id: "floating-blurred" };
  const events = [];
  let focused = false;
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => {
      focused = false;
      events.push("dismiss");
    },
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      focused = true;
      events.push("focus");
      return true;
    },
    isPaneKeyboardFocused: () => focused,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  focused = false;
  controller.sync(false);
  events.length = 0;

  controller.preserveState()();

  assert.deepEqual(events, ["dismiss", "hardware", "dismiss", "hardware", "update:false"]);
});

test("does not reopen an overlay keyboard on the next bottom key after a pane menu", () => {
  const pane = { id: "pane-menu-overlay" };
  const events = [];
  let focused = false;
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => {
      focused = false;
      events.push("dismiss");
    },
    enableAllPanes: () => {},
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => {
      focused = true;
      events.push("focus");
      return true;
    },
    isPaneKeyboardFocused: () => focused,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  const staleMenuRestore = controller.preserveState();
  events.length = 0;

  controller.dismissForOverlay(pane);
  staleMenuRestore();
  assert.deepEqual(events, ["dismiss", "update:false"]);

  events.length = 0;
  controller.preserveState()();
  assert.deepEqual(events, ["dismiss", "hardware", "dismiss", "hardware", "update:false"]);
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
  controller.sync(true);
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

test("does not restore a captured overlay keyboard onto another pane", () => {
  const firstPane = { id: "captured-first" };
  const secondPane = { id: "captured-second" };
  let pane = firstPane;
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

  controller.show(firstPane);
  const restoreShortcut = controller.preserveState();
  pane = secondPane;
  events.length = 0;

  restoreShortcut();

  assert.deepEqual(events, [
    "dismiss:captured-second",
    "hardware:captured-second",
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

test("keeps a remounted pane closed while the docked viewport finishes closing", () => {
  const pane = { id: "remount-docked" };
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: () => events.push("dismiss"),
    enableAllPanes: () => {},
    focusAutomaticPane: () => {
      events.push("automatic-focus");
      return true;
    },
    focusHardwarePane: () => events.push("hardware"),
    focusPane: () => true,
    preventAutoOpen: () => true,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(pane);
  controller.sync(true);
  controller.resetMountedPane(pane);
  events.length = 0;

  controller.preserveState()();

  assert.deepEqual(events, ["dismiss", "hardware", "dismiss", "hardware", "update:false"]);
});

test("keeps a newly active pane closed while the previous viewport finishes closing", () => {
  const firstPane = { id: "viewport-first" };
  const secondPane = { id: "viewport-second" };
  let pane = firstPane;
  const events = [];
  const controller = createMobileSystemKeyboardController({
    activePane: () => pane,
    dismissPane: (target) => events.push(`dismiss:${target.id}`),
    enableAllPanes: () => {},
    focusAutomaticPane: (target) => {
      events.push(`automatic:${target.id}`);
      return true;
    },
    focusHardwarePane: (target) => events.push(`hardware:${target.id}`),
    focusPane: () => true,
    preventAutoOpen: () => true,
    updateToggle: (next) => events.push(`update:${next}`),
  });

  controller.show(firstPane);
  controller.sync(true);
  pane = secondPane;
  controller.restoreState();
  events.length = 0;

  controller.preserveState()();

  assert.deepEqual(events, [
    "dismiss:viewport-second",
    "hardware:viewport-second",
    "dismiss:viewport-second",
    "hardware:viewport-second",
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
