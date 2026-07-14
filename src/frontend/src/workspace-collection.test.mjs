import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTabAfterSelectorReconcile,
  replaceSelectorTabs,
  selectorTabIdForWorkspaceId,
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

test("resolves a raw workspace tab only inside its selector", () => {
  const tabs = [
    { id: "view-local", selector: "app@box", workspaceTabId: "tab-1" },
    { id: "view-remote", selector: "client:pc", workspaceTabId: "tab-1" },
  ];
  assert.equal(
    selectorTabIdForWorkspaceId(tabs, "client:pc", "tab-1"),
    "view-remote",
  );
  assert.equal(
    selectorTabIdForWorkspaceId(tabs, "client:other", "tab-1"),
    undefined,
  );
});
