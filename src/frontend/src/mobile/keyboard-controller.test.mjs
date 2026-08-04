import assert from "node:assert/strict";
import test from "node:test";

import {
  mobileActionEventPhase,
  mobileSyntheticActivation,
} from "./action-event-phase.ts";
import { updateSystemKeyboardToggleState } from "./system-keyboard-state.ts";

test("uses one user-activation event for mobile actions", () => {
  assert.equal(mobileActionEventPhase("pane-menu"), "click");
  assert.equal(mobileActionEventPhase("toggle-system-keyboard"), "pointerup");
  assert.equal(mobileActionEventPhase("split-right"), "pointerdown");
  assert.equal(mobileActionEventPhase("copy-selection"), "pointerdown");
});

test("classifies only synthesized Page Up clicks for accessible activation", () => {
  const button = { dataset: { mobileShortcut: "pageUp", mobileRepeat: "true" } };
  assert.deepEqual(mobileSyntheticActivation(button, 0), {
    kind: "shortcut",
    value: "pageUp",
  });
  assert.equal(mobileSyntheticActivation(button, 1), undefined);
});

test("keeps keyboard activation for the system keyboard toggle without replaying a physical click", () => {
  const button = { dataset: { mobileAction: "toggle-system-keyboard" } };
  assert.deepEqual(mobileSyntheticActivation(button, 0), {
    kind: "action",
    value: "toggle-system-keyboard",
  });
  assert.equal(mobileSyntheticActivation(button, 1), undefined);
});

test("reflects the enabled system keyboard mode in the persistent toggle", () => {
  const classes = new Set();
  const attributes = new Map();
  const button = {
    classList: {
      toggle(name, active) {
        if (active) classes.add(name);
        else classes.delete(name);
      },
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
  updateSystemKeyboardToggleState(button, true);
  assert.equal(classes.has("active"), true);
  assert.equal(attributes.get("aria-pressed"), "true");

  updateSystemKeyboardToggleState(button, false);
  assert.equal(classes.has("active"), false);
  assert.equal(attributes.get("aria-pressed"), "false");
});
