import assert from "node:assert/strict";
import test from "node:test";
import { createSelectorRequestTracker } from "./selector-request-tracker.ts";

test("invalidates stale requests only within the same selector", () => {
  const tracker = createSelectorRequestTracker();
  const firstA = tracker.begin("app@box");
  const firstB = tracker.begin("client:pc");
  const secondA = tracker.begin("app@box");
  assert.equal(tracker.isCurrent("app@box", firstA), false);
  assert.equal(tracker.isCurrent("app@box", secondA), true);
  assert.equal(tracker.isCurrent("client:pc", firstB), true);
});
