import assert from "node:assert/strict";
import test from "node:test";
import {
  createExitedPaneCleanupController,
  hasExitedPaneForSelector,
  normalizeExitedWorkspaceState,
  shouldApplyWorkspaceActionResponse,
} from "./exited-pane-cleanup.ts";

test("applies a newer workspace action response when exited panes still need cleanup", () => {
  const panes = [
    { selector: "app@box", exited: false },
    { selector: "client:pc", exited: true },
  ];

  assert.equal(hasExitedPaneForSelector(panes, "client:pc"), true);
  assert.equal(hasExitedPaneForSelector(panes, "app@box"), false);
  assert.equal(shouldApplyWorkspaceActionResponse(false, true), true);
  assert.equal(shouldApplyWorkspaceActionResponse(false, false), false);
  assert.equal(shouldApplyWorkspaceActionResponse(undefined, false), true);
});

test("queues a second workspace reconcile when another pane exits in flight", async () => {
  let reconciles = 0;
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const controller = createExitedPaneCleanupController({
    reconcile: async () => {
      reconciles += 1;
      if (reconciles === 1) await firstPending;
    },
  });

  const first = controller.handle({ selector: "client:pc", paneId: "pane-1" });
  assert.equal(await controller.handle({ selector: "client:pc", paneId: "pane-1" }), false);
  assert.equal(await controller.handle({ selector: "client:pc", paneId: "pane-2" }), false);
  releaseFirst();

  assert.equal(await first, true);
  assert.equal(reconciles, 2);
});

test("permits retry after workspace reconciliation fails", async () => {
  let reconciles = 0;
  const controller = createExitedPaneCleanupController({
    reconcile: async () => {
      reconciles += 1;
      if (reconciles === 1) throw new Error("temporary workspace failure");
    },
  });

  assert.equal(await controller.handle({ selector: "client:pc", paneId: "pane-1" }), false);
  assert.equal(await controller.handle({ selector: "client:pc", paneId: "pane-1" }), true);
  assert.equal(reconciles, 2);
});

test("releases panes queued behind a failed reconciliation for retry", async () => {
  let reconciles = 0;
  let releaseFirst;
  const firstPending = new Promise((resolve) => { releaseFirst = resolve; });
  const controller = createExitedPaneCleanupController({
    reconcile: async () => {
      reconciles += 1;
      if (reconciles === 1) {
        await firstPending;
        throw new Error("temporary workspace failure");
      }
    },
  });

  const first = controller.handle({ selector: "client:pc", paneId: "pane-1" });
  assert.equal(await controller.handle({ selector: "client:pc", paneId: "pane-2" }), false);
  releaseFirst();
  assert.equal(await first, false);

  assert.equal(await controller.handle({ selector: "client:pc", paneId: "pane-2" }), true);
  assert.equal(reconciles, 2);
});

test("removes exited remote panes and collapses their split layout", () => {
  const workspace = normalizeExitedWorkspaceState({
    selector: "client:pc",
    active_tab_id: "tab-1",
    tabs: [{
      id: "tab-1",
      label: "1",
      active_pane_id: "pane-2",
      layout: {
        type: "split",
        axis: "columns",
        children: [
          { type: "pane", paneId: "pane-1" },
          { type: "pane", paneId: "pane-2" },
        ],
      },
      panes: [
        { id: "pane-1", session_id: "pane-1", status: "running", cols: 80, rows: 24 },
        { id: "pane-2", session_id: "pane-2", status: "exited", cols: 80, rows: 24 },
      ],
    }],
  }, true);

  assert.deepEqual(workspace.tabs[0].panes.map((pane) => pane.id), ["pane-1"]);
  assert.deepEqual(workspace.tabs[0].layout, { type: "pane", paneId: "pane-1" });
  assert.equal(workspace.tabs[0].active_pane_id, "pane-1");
});

test("drops a remote tab when its final pane already exited", () => {
  const workspace = normalizeExitedWorkspaceState({
    selector: "client:pc",
    active_tab_id: "tab-1",
    tabs: [{
      id: "tab-1",
      label: "1",
      active_pane_id: "pane-1",
      layout: { type: "pane", paneId: "pane-1" },
      panes: [
        { id: "pane-1", session_id: "pane-1", status: "exited", cols: 80, rows: 24 },
      ],
    }],
  }, true);

  assert.deepEqual(workspace.tabs, []);
  assert.equal(workspace.active_tab_id, undefined);
});

test("keeps one provider-owned pane when every pane in a tab exited", () => {
  const workspace = normalizeExitedWorkspaceState({
    selector: "app@owner",
    active_tab_id: "tab-1",
    tabs: [{
      id: "tab-1",
      label: "1",
      active_pane_id: "pane-2",
      layout: {
        type: "split",
        axis: "rows",
        children: [
          { type: "pane", paneId: "pane-1" },
          { type: "pane", paneId: "pane-2" },
        ],
      },
      panes: [
        { id: "pane-1", session_id: "session-1", status: "exited", cols: 80, rows: 24 },
        { id: "pane-2", session_id: "session-2", status: "exited", cols: 80, rows: 24 },
      ],
    }],
  }, false);

  assert.deepEqual(workspace.tabs[0].panes.map((pane) => pane.id), ["pane-2"]);
  assert.deepEqual(workspace.tabs[0].layout, { type: "pane", paneId: "pane-2" });
  assert.equal(workspace.tabs[0].active_pane_id, "pane-2");
});

test("preserves an explicitly protected exited pane beside a running pane", () => {
  const workspace = normalizeExitedWorkspaceState({
    selector: "app@owner",
    active_tab_id: "tab-1",
    tabs: [{
      id: "tab-1",
      label: "1",
      active_pane_id: "pane-recovering",
      layout: {
        type: "split",
        axis: "columns",
        children: [
          { type: "pane", paneId: "pane-running" },
          { type: "pane", paneId: "pane-recovering" },
        ],
      },
      panes: [
        { id: "pane-running", session_id: "session-1", status: "running", cols: 80, rows: 24 },
        { id: "pane-recovering", session_id: "session-2", status: "exited", cols: 80, rows: 24 },
      ],
    }],
  }, false, new Set(["pane-recovering"]));

  assert.deepEqual(
    workspace.tabs[0].panes.map((pane) => pane.id),
    ["pane-running", "pane-recovering"],
  );
});

test("preserves an unclassified local Herdr exit until recovery owns the decision", () => {
  const state = {
    selector: "app@owner",
    active_tab_id: "tab-1",
    tabs: [{
      id: "tab-1",
      label: "1",
      active_pane_id: "herdr-exit",
      layout: {
        type: "split",
        axis: "columns",
        children: [
          { type: "pane", paneId: "running" },
          { type: "pane", paneId: "herdr-exit" },
        ],
      },
      panes: [
        { id: "running", session_id: "session-1", status: "running", session_backend: "webshell", cols: 80, rows: 24 },
        { id: "herdr-exit", session_id: "session-2", status: "exited", session_backend: "herdr", cols: 80, rows: 24 },
      ],
    }],
  };

  const unclassified = normalizeExitedWorkspaceState(
    state,
    false,
    new Set(),
    new Set(),
    new Set(["herdr-exit"]),
  );
  assert.deepEqual(unclassified.tabs[0].panes.map((pane) => pane.id), ["running", "herdr-exit"]);

  const ordinary = normalizeExitedWorkspaceState(
    state,
    false,
    new Set(),
    new Set(["herdr-exit"]),
    new Set(["herdr-exit"]),
  );
  assert.deepEqual(ordinary.tabs[0].panes.map((pane) => pane.id), ["running"]);

  const freshLoad = normalizeExitedWorkspaceState(state, false);
  assert.deepEqual(freshLoad.tabs[0].panes.map((pane) => pane.id), ["running"]);

  const onlyHerdr = normalizeExitedWorkspaceState({
    selector: "app@owner",
    active_tab_id: "tab-1",
    tabs: [{
      id: "tab-1",
      label: "1",
      active_pane_id: "herdr-exit",
      layout: { type: "pane", paneId: "herdr-exit" },
      panes: [{
        id: "herdr-exit",
        session_id: "session-2",
        status: "exited",
        session_backend: "herdr",
        cols: 80,
        rows: 24,
      }],
    }],
  }, false);
  assert.deepEqual(onlyHerdr.tabs, []);
});
