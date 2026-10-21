import assert from "node:assert/strict";
import test from "node:test";

import { preferredAvailableBackend } from "./session-backends.ts";

test("missing Herdr falls back for the current instance without changing the preference", () => {
  const state = {
    selector: "alpha@owner",
    backends: [{ id: "webshell", label: "WebShell native", available: true }],
  };
  const preferred = "herdr";
  assert.equal(preferredAvailableBackend(state, preferred), "webshell");
  assert.equal(preferred, "herdr");
  assert.equal(preferredAvailableBackend({ ...state, backends: [
    ...state.backends,
    { id: "herdr", label: "Herdr", available: true },
  ] }, preferred), "herdr");
});
