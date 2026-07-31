import assert from "node:assert/strict";
import test from "node:test";

import { applyHerdrPaneFocus, applyHerdrResourceEvent } from "./herdr-state-events.ts";

function stateFixture() {
  return {
    selector: "demo@owner",
    available: true,
    herdr_version: "0.7.4",
    herdr_protocol: 16,
    supported_herdr_version: "0.7.4",
    supported_protocol: 16,
    socket_schema_version: 1,
    socket_source_revision: "a22454f27ce096585e19d1787dba43f56d1505cf",
    workspaces: [
      {
        workspace_id: "w1",
        number: 1,
        label: "repo",
        focused: true,
        active_tab_id: "w1:t1",
        tab_count: 1,
        pane_count: 1,
        tokens: {},
      },
      {
        workspace_id: "w2",
        number: 2,
        label: "other",
        focused: false,
        active_tab_id: "w2:t2",
        tab_count: 1,
        pane_count: 1,
        tokens: {},
      },
    ],
    tabs: [
      {
        tab_id: "w1:t1",
        workspace_id: "w1",
        number: 1,
        label: "1",
        focused: true,
        pane_count: 1,
      },
      {
        tab_id: "w2:t2",
        workspace_id: "w2",
        number: 2,
        label: "2",
        focused: false,
        pane_count: 1,
      },
    ],
    panes: [
      {
        pane_id: "w1:p1",
        workspace_id: "w1",
        tab_id: "w1:t1",
        focused: true,
        agent_status: "working",
        tokens: {},
      },
      {
        pane_id: "w2:p2",
        workspace_id: "w2",
        tab_id: "w2:t2",
        focused: false,
        agent_status: "idle",
        tokens: {},
      },
    ],
    agents: [],
  };
}

test("applies Herdr focus events immediately across workspaces, tabs, and panes", () => {
  const initial = stateFixture();
  const workspaceFocused = applyHerdrResourceEvent(initial, "workspace.focused", {
    workspace_id: "w2",
  });
  assert.equal(workspaceFocused.applied, true);
  assert.deepEqual(workspaceFocused.state.workspaces.map((workspace) => workspace.focused), [false, true]);

  const tabFocused = applyHerdrResourceEvent(workspaceFocused.state, "tab.focused", {
    workspace_id: "w2",
    tab_id: "w2:t2",
  });
  assert.equal(tabFocused.applied, true);
  assert.equal(tabFocused.state.workspaces[1].active_tab_id, "w2:t2");
  assert.deepEqual(tabFocused.state.tabs.map((tab) => tab.focused), [false, true]);

  const paneFocused = applyHerdrResourceEvent(initial, "pane.focused", {
    workspace_id: "w2",
    pane_id: "w2:p2",
  });
  assert.equal(paneFocused.applied, true);
  assert.deepEqual(paneFocused.state.workspaces.map((workspace) => workspace.focused), [false, true]);
  assert.deepEqual(paneFocused.state.tabs.map((tab) => tab.focused), [false, true]);
  assert.deepEqual(paneFocused.state.panes.map((pane) => pane.focused), [false, true]);
});

test("applies a pane focus domain transition without fabricating a socket event", () => {
  const initial = stateFixture();
  const result = applyHerdrPaneFocus(initial, "w2:p2");

  assert.equal(result.applied, true);
  assert.deepEqual(result.state.workspaces.map((workspace) => workspace.focused), [false, true]);
  assert.deepEqual(result.state.tabs.map((tab) => tab.focused), [false, true]);
  assert.deepEqual(result.state.panes.map((pane) => pane.focused), [false, true]);
});

test("replaces workspace metadata snapshots immutably", () => {
  const state = stateFixture();
  const result = applyHerdrResourceEvent(state, "workspace.metadata_updated", {
    workspace: { ...state.workspaces[0], tokens: { summary: "done" } },
  });

  assert.equal(result.applied, true);
  assert.notEqual(result.state, state);
  assert.deepEqual(result.state.workspaces[0].tokens, { summary: "done" });
  assert.deepEqual(state.workspaces[0].tokens, {});
});

test("replaces pane presentation snapshots immutably", () => {
  const state = stateFixture();
  const result = applyHerdrResourceEvent(state, "pane.updated", {
    pane: { ...state.panes[0], terminal_title_stripped: "Codex · auth" },
  });

  assert.equal(result.applied, true);
  assert.notEqual(result.state, state);
  assert.equal(result.state.panes[0].terminal_title_stripped, "Codex · auth");
  assert.equal(state.panes[0].terminal_title_stripped, undefined);
});

test("does not invent unknown or malformed Herdr resources", () => {
  const state = stateFixture();
  assert.deepEqual(applyHerdrResourceEvent(state, "pane.updated", {
    pane: { ...state.panes[0], pane_id: "w1:p9" },
  }), { state, applied: false });
  assert.deepEqual(applyHerdrResourceEvent(state, "workspace.metadata_updated", {
    workspace: { ...state.workspaces[0], workspace_id: "w9" },
  }), { state, applied: false });
  assert.deepEqual(applyHerdrResourceEvent(state, "pane.updated", { pane: {} }), {
    state,
    applied: false,
  });
  assert.deepEqual(applyHerdrResourceEvent(state, "tab.renamed", {}), {
    state,
    applied: false,
  });
});
