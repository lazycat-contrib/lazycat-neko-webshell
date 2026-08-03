import assert from "node:assert/strict";
import test from "node:test";

import { normalizePreventMobileKeyboardAutoOpen } from "./keyboard-preference.ts";

test("keeps mobile keyboard auto-open behavior unless prevention is explicitly enabled", () => {
  assert.equal(normalizePreventMobileKeyboardAutoOpen(undefined), false);
  assert.equal(normalizePreventMobileKeyboardAutoOpen(true), true);
  assert.equal(normalizePreventMobileKeyboardAutoOpen(false), false);
  assert.equal(normalizePreventMobileKeyboardAutoOpen("true"), false);
});
