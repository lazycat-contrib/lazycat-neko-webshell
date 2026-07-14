import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTabAfterSelectorReconcile,
  replaceSelectorTabs,
} from "./workspace-collection.ts";

const tab = (id, selector) => ({ id, selector });

test("replaces one selector without removing sibling selectors", () => {
  const result = replaceSelectorTabs(
    [tab("local-1", "app@box"), tab("remote-old", "client:pc")],
    "client:pc",
    [tab("remote-new", "client:pc")],
    "local-1",
  );
  assert.deepEqual(result.map((item) => item.id), ["local-1", "remote-new"]);
});

test("background reconciliation preserves the active tab", () => {
  assert.equal(
    activeTabAfterSelectorReconcile(
      "local-1",
      [tab("local-1", "app@box"), tab("remote-1", "client:pc")],
      "client:pc",
      "remote-1",
      false,
    ),
    "local-1",
  );
});
