import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetOpenSelector,
  readOpenSelectors,
  rememberOpenSelector,
} from "./open-workspaces.ts";

test("stores normalized selectors once and preserves open order", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  rememberOpenSelector(" app@box ", storage);
  rememberOpenSelector("client:pc", storage);
  rememberOpenSelector("app@box", storage);
  assert.deepEqual(readOpenSelectors(storage), ["app@box", "client:pc"]);
  forgetOpenSelector("app@box", storage);
  assert.deepEqual(readOpenSelectors(storage), ["client:pc"]);
});
