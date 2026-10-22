import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrLazycatNotificationController } from "./controller.ts";

test("reconciles an action snapshot before reseeding its completion marker", () => {
  let state = {
    herdr_version: "0.9.3", panes: [], workspaces: [], tabs: [],
    agents: [{ terminal_id: "terminal-1", pane_id: "pane-1", agent_status: "working" }],
  };
  const notifications = [];
  const controller = createHerdrLazycatNotificationController({
    state: () => state, enabled: () => true, tr: (key) => key,
    send: async (payload) => notifications.push(payload), onError: assert.fail,
  });
  controller.seed();
  state = { ...state, agents: [{ ...state.agents[0], agent_status: "idle", completion_seq: 11 }] };
  controller.reconcile();
  controller.reset();
  controller.seed();
  controller.reconcile();
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].title, "herdrNotification.doneTitle");
});

test("UI alerts remain active with system notifications disabled and consume their completion", () => {
  let enabled = false;
  let state = {
    herdr_version: "0.9.3", panes: [], workspaces: [], tabs: [],
    agents: [{ terminal_id: "terminal-1", pane_id: "pane-1", agent_status: "working" }],
  };
  const alerts = [], notifications = [];
  const controller = createHerdrLazycatNotificationController({
    state: () => state, enabled: () => enabled, tr: (key) => key,
    onTransition: (transition) => alerts.push(transition.kind),
    send: async (payload) => notifications.push(payload), onError: assert.fail,
  });
  controller.seed();
  state = { ...state, agents: [{ ...state.agents[0], agent_status: "idle", completion_seq: 7 }] };
  controller.reconcile();
  enabled = true;
  controller.reconcile();
  assert.deepEqual(alerts, ["done"]);
  assert.deepEqual(notifications, []);
  state = { ...state, agents: [{ ...state.agents[0], completion_seq: 9 }] };
  controller.reconcile();
  assert.deepEqual(alerts, ["done", "done"]);
  assert.equal(notifications.length, 1);
});
