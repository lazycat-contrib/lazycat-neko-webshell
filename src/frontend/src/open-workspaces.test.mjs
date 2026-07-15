import assert from "node:assert/strict";
import test from "node:test";
import {
  forgetOpenSelector,
  readOpenSelectors,
  rememberOpenSelector,
  syncOpenSelectorFromWorkspace,
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

test("syncs selector persistence from authoritative workspace tab count", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  rememberOpenSelector("client:pc", storage);

  assert.equal(syncOpenSelectorFromWorkspace("client:pc", 1, storage), true);
  assert.deepEqual(readOpenSelectors(storage), ["client:pc"]);

  assert.equal(syncOpenSelectorFromWorkspace("client:pc", 0, storage), false);
  assert.deepEqual(readOpenSelectors(storage), []);
});
