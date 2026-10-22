import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrNotificationPolicy } from "./policy.ts";

const pane = (status, overrides = {}) => ({
  pane_id: "pane-1", workspace_id: "workspace-1", tab_id: "tab-1",
  focused: true, agent_status: status, tokens: {}, ...overrides,
});
const agent = (sequence, overrides = {}) => ({
  ...pane("idle"), terminal_id: "terminal-1", revision: 1,
  launch_pending: false, interactive_ready: true, state_change_seq: sequence,
  completion_seq: sequence, ...overrides,
});

test("notifies once for new blocked and done snapshots on legacy Herdr", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("working")]);
  assert.deepEqual(policy.reconcile([], [pane("blocked", { display_agent: "Codex" })]), [{
    kind: "blocked", paneId: "pane-1", workspaceId: "workspace-1", agent: "", displayAgent: "Codex",
  }]);
  assert.deepEqual(policy.reconcile([], [pane("blocked", { title: "Renamed" })]), []);
  assert.deepEqual(policy.reconcile([], [pane("working")]), []);
  assert.equal(policy.reconcile([], [pane("done")])[0]?.kind, "done");
  assert.deepEqual(policy.reconcile([], [pane("idle")]), []);
});

test("legacy focused working through an approval still completes on idle", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("working")]);
  assert.equal(policy.reconcile([], [pane("blocked")])[0]?.kind, "blocked");
  assert.equal(policy.reconcile([], [pane("idle")])[0]?.kind, "done");
  assert.deepEqual(policy.reconcile([], [pane("idle")]), []);
});

test("startup approval becoming idle is not completed work", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("blocked")]);
  assert.deepEqual(policy.reconcile([], [pane("idle")]), []);
});

test("startup, new panes and reconnects establish silent status baselines", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("done")]);
  assert.deepEqual(policy.reconcile([], [pane("done"), pane("blocked", { pane_id: "new-pane" })]), []);
  policy.reset();
  assert.deepEqual(policy.reconcile([], [pane("blocked")]), []);
  policy.seed([pane("blocked")]);
  assert.deepEqual(policy.reconcile([], [pane("blocked")]), []);
});

test("uses authoritative completion markers once without notifying on startup or reconnect", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("working")], [agent(undefined, { agent_status: "working" })], true);
  assert.equal(policy.reconcile([agent(7)])[0]?.kind, "done");
  assert.deepEqual(policy.reconcile([agent(7)]), []);
  policy.seed([pane("idle")], [agent(7)], true);
  assert.deepEqual(policy.reconcile([agent(7)]), []);
  assert.equal(policy.reconcile([agent(9)])[0]?.kind, "done");
});

test("existing completion survives new tab and title refreshes without notifying again", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("done")], [agent(7, { agent_status: "done" })], true);
  for (const status of ["done", "idle", "done"]) {
    assert.deepEqual(policy.reconcile([agent(7, { agent_status: status, title: "Changed" })], [
      pane(status), pane("unknown", { pane_id: "new-tab-pane" }),
    ]), []);
  }
  assert.equal(policy.reconcile([agent(9)])[0]?.kind, "done");
});

test("a temporarily absent completion marker cannot replay the old completion", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("idle")], [agent(7)], true);
  assert.deepEqual(policy.reconcile([agent(undefined)]), []);
  assert.deepEqual(policy.reconcile([agent(7)]), []);
  assert.equal(policy.reconcile([agent(9)])[0]?.kind, "done");
});

test("marker-capable Herdr does not interpret a repeated done status as a new completion", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("idle")], [agent(7)], true);
  assert.deepEqual(policy.reconcile([agent(7, { agent_status: "working" })]), []);
  assert.deepEqual(policy.reconcile([agent(7, { agent_status: "done" })]), []);
  assert.equal(policy.reconcile([agent(9, { agent_status: "done" })])[0]?.kind, "done");
});

test("completion markers do not replay for replaced terminals, removed agents or reset streams", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("idle")], [agent(7)], true);
  assert.deepEqual(policy.reconcile([agent(9, { terminal_id: "replacement", agent_status: "blocked" })]), []);
  assert.deepEqual(policy.reconcile([]), []);
  assert.deepEqual(policy.reconcile([agent(10)]), []);
  policy.reset();
  assert.deepEqual(policy.reconcile([agent(11)]), []);
});

test("replaced terminal cannot inherit the previous terminal's working status", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("working")], [agent(undefined, { agent_status: "working" })]);
  assert.deepEqual(policy.reconcile([agent(undefined, { terminal_id: "replacement" })]), []);
});

test("a restarted completion sequence establishes a new baseline", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("idle")], [agent(20)], true);
  assert.deepEqual(policy.reconcile([agent(2)]), []);
  assert.equal(policy.reconcile([agent(4)])[0]?.kind, "done");
});

test("blocked snapshots remain notifiable with completion markers", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("working")], [agent(undefined, { agent_status: "working" })], true);
  assert.equal(policy.reconcile([agent(undefined, { agent_status: "blocked" })])[0]?.kind, "blocked");
  assert.deepEqual(policy.reconcile([agent(undefined, { agent_status: "blocked", title: "Changed" })]), []);
  assert.equal(policy.reconcile([agent(7)])[0]?.kind, "done");
});

test("a completed task still notifies when the next task starts before the snapshot", () => {
  const policy = createHerdrNotificationPolicy();
  policy.seed([pane("working")], [agent(7, { agent_status: "working" })], true);
  assert.equal(policy.reconcile([agent(9, { agent_status: "working" })])[0]?.kind, "done");
  assert.deepEqual(policy.reconcile([agent(9)]), []);
});
