import assert from "node:assert/strict";
import test from "node:test";
import {
  workspaceEntityId,
  workspaceLayoutToRaw,
  workspaceLayoutToView,
} from "./workspace-identity.ts";

test("namespaces identical remote workspace IDs by selector", () => {
  assert.notEqual(
    workspaceEntityId("client:first", "tab", "tab-1"),
    workspaceEntityId("client:second", "tab", "tab-1"),
  );
  assert.notEqual(
    workspaceEntityId("client:first", "pane", "pane-1"),
    workspaceEntityId("client:second", "pane", "pane-1"),
  );
});

test("round-trips pane IDs inside split layouts", () => {
  const raw = {
    type: "split",
    axis: "columns",
    children: [
      { type: "pane", paneId: "pane-1" },
      { type: "pane", paneId: "pane-2" },
    ],
  };
  const view = workspaceLayoutToView("client:first", raw);
  assert.deepEqual(workspaceLayoutToRaw("client:first", view), raw);
  assert.equal(workspaceLayoutToRaw("client:second", view), undefined);
});
