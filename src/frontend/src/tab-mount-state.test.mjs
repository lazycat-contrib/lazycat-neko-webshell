import assert from "node:assert/strict";
import test from "node:test";

import { syncActiveTabMounts } from "./tab-mount-state.ts";

function tab(id, active) {
  const classes = new Set(active ? ["active"] : []);
  const attributes = new Map([["aria-hidden", active ? "false" : "true"]]);
  return {
    id,
    mount: {
      classList: {
        toggle(name, enabled) {
          if (enabled) classes.add(name);
          else classes.delete(name);
        },
        contains: (name) => classes.has(name),
      },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name),
    },
  };
}

test("switches terminal mounts when pane activation crosses tabs", () => {
  const first = tab("first", true);
  const second = tab("second", false);

  syncActiveTabMounts([first, second], "second");

  assert.equal(first.mount.classList.contains("active"), false);
  assert.equal(first.mount.getAttribute("aria-hidden"), "true");
  assert.equal(second.mount.classList.contains("active"), true);
  assert.equal(second.mount.getAttribute("aria-hidden"), "false");
});
