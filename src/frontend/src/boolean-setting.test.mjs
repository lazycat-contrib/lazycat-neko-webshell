import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBooleanSetting } from "./boolean-setting.ts";

test("accepts only boolean setting values", () => {
  assert.equal(normalizeBooleanSetting(true, false), true);
  assert.equal(normalizeBooleanSetting(false, true), false);
  assert.equal(normalizeBooleanSetting("false", false), false);
  assert.equal(normalizeBooleanSetting({}, true), true);
});
