import assert from "node:assert/strict";
import test from "node:test";

import { mobileActionEventPhase } from "./action-event-phase.ts";

test("opens the pane menu after the triggering click has finished", () => {
  assert.equal(mobileActionEventPhase("pane-menu"), "click");
  assert.equal(mobileActionEventPhase("split-right"), "pointerdown");
  assert.equal(mobileActionEventPhase("copy-selection"), "pointerdown");
});
