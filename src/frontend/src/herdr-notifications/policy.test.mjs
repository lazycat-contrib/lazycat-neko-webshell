import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrNotificationPolicy } from "./policy.ts";

const pane = (paneId, status) => ({
  pane_id: paneId,
  workspace_id: "workspace-1",
  tab_id: "tab-1",
  focused: true,
  agent_status: status,
  tokens: {},
});

test("notifies only on new done and blocked status edges", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "working")]);

  assert.deepEqual(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    workspace_id: "workspace-1",
    agent_status: "blocked",
    display_agent: "Codex",
  }), {
    kind: "blocked",
    paneId: "pane-1",
    workspaceId: "workspace-1",
    agent: "",
    displayAgent: "Codex",
  });
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    agent_status: "blocked",
    title: "Waiting for confirmation",
  }), undefined);
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    agent_status: "working",
  }), undefined);
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    agent_status: "done",
  })?.kind, "done");
});

test("treats a focused agent becoming idle as completed", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "working")]);

  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    agent_status: "idle",
  })?.kind, "done");
});

test("suppresses initial subscription and reconnect snapshots", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "done")]);

  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    agent_status: "done",
  }), undefined);
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "new-pane",
    agent_status: "blocked",
  }), undefined);

  policy.reset();
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1",
    agent_status: "done",
  }), undefined);
});
