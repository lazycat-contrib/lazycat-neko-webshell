import assert from "node:assert/strict";
import test from "node:test";

import { herdrHistoryTabTarget } from "./view-focus.ts";

test("cycles Tab and Shift+Tab at the history modal boundaries", () => {
  const first = { id: "close" };
  const middle = { id: "query" };
  const last = { id: "preview" };
  const focusable = [first, middle, last];

  assert.equal(herdrHistoryTabTarget(focusable, last, false), first);
  assert.equal(herdrHistoryTabTarget(focusable, first, true), last);
  assert.equal(herdrHistoryTabTarget(focusable, middle, false), undefined);
  assert.equal(herdrHistoryTabTarget(focusable, undefined, false), first);
  assert.equal(herdrHistoryTabTarget([], undefined, false), undefined);
});
