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

test("startup confirmation becoming idle is not completed work", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "blocked")]);
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1", agent_status: "idle",
  }), undefined);
});

const agent = (sequence, overrides = {}) => ({
  ...pane("pane-1", "idle"), terminal_id: "terminal-1", revision: 1,
  launch_pending: false, interactive_ready: true, state_change_seq: sequence,
  completion_seq: sequence, ...overrides,
});

test("uses authoritative completion markers once without notifying on startup or reconnect", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "blocked")], [agent(undefined)], true);
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1", agent_status: "idle",
  }), undefined);
  assert.deepEqual(policy.reconcile([agent(undefined)]), []);
  assert.equal(policy.reconcile([agent(7)])[0]?.kind, "done");
  assert.deepEqual(policy.reconcile([agent(7)]), []);
  policy.seed([pane("pane-1", "idle")], [agent(7)], true);
  assert.deepEqual(policy.reconcile([agent(7)]), []);
  assert.equal(policy.reconcile([agent(9)])[0]?.kind, "done");
});

test("completion markers do not replay for new terminals, removed agents or a reset stream", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "idle")], [agent(7)], true);
  assert.deepEqual(policy.reconcile([agent(9, { terminal_id: "replacement" })]), []);
  assert.deepEqual(policy.reconcile([]), []);
  assert.deepEqual(policy.reconcile([agent(10)]), []);
  policy.reset();
  assert.deepEqual(policy.reconcile([agent(11)]), []);
});

test("legacy working through an approval still completes", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "working")]);
  policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "blocked" });
  assert.equal(policy.handle("pane.agent_status_changed", {
    pane_id: "pane-1", agent_status: "idle",
  })?.kind, "done");
});

test("legacy done followed by viewing idle does not notify twice", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "working")]);
  assert.equal(policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "done" })?.kind, "done");
  assert.equal(policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "idle" }), undefined);
});

test("a restarted completion sequence establishes a new baseline", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "idle")], [agent(20)], true);
  assert.deepEqual(policy.reconcile([agent(2)]), []);
  assert.equal(policy.reconcile([agent(4)])[0]?.kind, "done");
});

test("a real done edge survives the next task starting before the snapshot", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "working")], [agent(undefined, { agent_status: "working" })], true);
  assert.equal(policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "done" })?.kind, "done");
  policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "working" });
  assert.deepEqual(policy.reconcile([agent(undefined, { agent_status: "working" })]), []);
});

test("deduplicates the done edge and the matching authoritative marker", () => {
  for (const snapshotFirst of [false, true]) {
    const policy = createHerdrNotificationPolicy();
    policy.seed([pane("pane-1", "working")], [agent(undefined)], true);
    const wire = () => policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "done" });
    const snapshot = () => policy.reconcile([agent(7)]);
    const notifications = snapshotFirst ? [...snapshot(), wire()] : [wire(), ...snapshot()];
    assert.equal(notifications.filter(Boolean).length, 1);
  }
});

test("consumes a wire completion so recovery can notify a later task after lost events", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("pane-1", "working")], [agent(undefined)], true);
  assert.equal(policy.handle("pane.agent_status_changed", { pane_id: "pane-1", agent_status: "done" })?.kind, "done");
  assert.deepEqual(policy.reconcile([agent(7)]), []);
  assert.equal(policy.reconcile([agent(9)])[0]?.kind, "done");
});
