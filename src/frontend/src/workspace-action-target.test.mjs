import assert from "node:assert/strict";
import test from "node:test";
import { resolveWorkspaceActionTarget } from "./workspace-action-target.ts";
import { workspaceLayoutToView } from "./workspace-identity.ts";

const tabs = [
  {
    id: "view-local-tab",
    workspaceTabId: "tab-1",
    selector: "app@box",
    panes: [{ id: "view-local-pane", workspacePaneId: "pane-1", selector: "app@box" }],
  },
  {
    id: "view-remote-tab",
    workspaceTabId: "tab-1",
    selector: "client:pc",
    panes: [{ id: "view-remote-pane", workspacePaneId: "pane-1", selector: "client:pc" }],
  },
];

test("converts view IDs back to selector-local workspace IDs", () => {
  const layout = workspaceLayoutToView("client:pc", {
    type: "pane",
    paneId: "pane-1",
  });
  assert.deepEqual(
    resolveWorkspaceActionTarget(tabs, "client:pc", {
      tabId: "view-remote-tab",
      paneId: "view-remote-pane",
      activePaneId: "view-remote-pane",
      layout,
    }),
    {
      tabId: "tab-1",
      paneId: "pane-1",
      activePaneId: "pane-1",
      layout: { type: "pane", paneId: "pane-1" },
    },
  );
});

test("does not send identities or layouts from another selector", () => {
  const layout = workspaceLayoutToView("app@box", {
    type: "pane",
    paneId: "pane-1",
  });
  assert.deepEqual(
    resolveWorkspaceActionTarget(tabs, "client:pc", {
      tabId: "view-local-tab",
      paneId: "view-local-pane",
      activePaneId: "view-local-pane",
      layout,
    }),
    {
      tabId: undefined,
      paneId: undefined,
      activePaneId: undefined,
      layout: undefined,
    },
  );
});
