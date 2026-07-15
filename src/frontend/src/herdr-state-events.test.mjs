import assert from "node:assert/strict";
import test from "node:test";

import { applyHerdrResourceEvent } from "./herdr-state-events.ts";

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
    workspaces: [{
      workspace_id: "w1",
      number: 1,
      label: "repo",
      focused: true,
      active_tab_id: "w1:t1",
      tab_count: 1,
      pane_count: 1,
      tokens: {},
    }],
    tabs: [{
      tab_id: "w1:t1",
      workspace_id: "w1",
      number: 1,
      label: "1",
      focused: true,
      pane_count: 1,
    }],
    panes: [{
      pane_id: "w1:p1",
      workspace_id: "w1",
      tab_id: "w1:t1",
      focused: true,
      agent_status: "working",
      tokens: {},
    }],
  };
}

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
