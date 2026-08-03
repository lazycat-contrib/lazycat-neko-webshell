import assert from "node:assert/strict";
import test from "node:test";

import {
  mobileActionEventPhase,
  mobileSyntheticActivation,
} from "./action-event-phase.ts";
import { updateSystemKeyboardToggleState } from "./system-keyboard-state.ts";

test("opens the pane menu after the triggering click has finished", () => {
  assert.equal(mobileActionEventPhase("pane-menu"), "click");
  assert.equal(mobileActionEventPhase("toggle-system-keyboard"), "click");
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
