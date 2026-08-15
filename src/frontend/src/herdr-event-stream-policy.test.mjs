import assert from "node:assert/strict";
import test from "node:test";

import {
  createHerdrEventStreamPolicy,
  herdrEventBridgeShouldSubscribe,
} from "./herdr-event-stream-policy.ts";

test("subscribes to an available external Herdr runtime without a WebShell Herdr pane", () => {
  assert.equal(herdrEventBridgeShouldSubscribe("demo@owner", true), true);
  assert.equal(herdrEventBridgeShouldSubscribe("", true), false);
  assert.equal(herdrEventBridgeShouldSubscribe("demo@owner", false), false);
});

test("keeps delayed Herdr history on the authoritative reconciliation path", () => {
  const policy = createHerdrEventStreamPolicy();
  const subscribedPaneIds = ["w1:p1", "w1:p2", "w1:p3"];
  policy.beginSubscription(subscribedPaneIds);

  const started = policy.handle({
    id: "lazycat-webshell:events",
    result: { type: "subscription_started" },
  });
  assert.equal(started.requestReconcile, true);

  const historical = [
    { event: "workspace.focused", data: { workspace_id: "w1" } },
    { event: "tab.created", data: { tab: { tab_id: "w1:t2", workspace_id: "w1" } } },
    { event: "tab.focused", data: { workspace_id: "w1", tab_id: "w1:t1" } },
    { event: "pane.created", data: { pane: { pane_id: "w1:p2", tab_id: "w1:t2" } } },
    { event: "pane.focused", data: { workspace_id: "w1", pane_id: "w1:p1" } },
    { event: "tab.created", data: { tab: { tab_id: "w1:t3", workspace_id: "w1" } } },
  ].map((envelope) => policy.handle(envelope));

  for (const decision of historical) {
    assert.equal(decision.requestReconcile, true);
  }

  assert.deepEqual(policy.reconciled(started.token, subscribedPaneIds), {
    current: false,
    resubscribe: false,
  });
  assert.deepEqual(policy.reconciled(historical.at(-1).token, subscribedPaneIds), {
    current: true,
    resubscribe: false,
  });

  const delayedFocus = policy.handle({
    event: "tab.focused",
    data: { workspace_id: "w1", tab_id: "w1:t3" },
  });
  assert.equal(delayedFocus.requestReconcile, true);
  assert.equal(delayedFocus.presentEvent, false);
  assert.equal(policy.retryDelay(delayedFocus.token, 0), 300);
  assert.equal(policy.retryDelay(delayedFocus.token, 20), 5000);

  policy.reset();
  assert.equal(policy.retryDelay(delayedFocus.token, 0), undefined);
});

test("presents only pane status events whose Herdr subscription starts at the current sequence", () => {
  const policy = createHerdrEventStreamPolicy();
  policy.beginSubscription(["w1:p1"]);

  assert.equal(policy.handle({
    event: "pane.agent_detected",
    data: { pane_id: "w1:p1", released: true, final_status: "blocked" },
  }).presentEvent, false);
  assert.equal(policy.handle({
    event: "pane.agent_status_changed",
    data: { pane_id: "w1:p1", agent_status: "blocked" },
  }).presentEvent, true);
});

test("resubscribes only when an authoritative snapshot changes the pane set", () => {
  const policy = createHerdrEventStreamPolicy();
  policy.beginSubscription(["w1:p1"]);
  const replay = policy.handle({ event: "pane.created", data: { pane: { pane_id: "w1:p1" } } });

  assert.equal(policy.reconciled(replay.token, ["w1:p1"]).resubscribe, false);

  const structural = policy.handle({
    event: "pane.created",
    data: { pane: { pane_id: "w1:p2", tab_id: "w1:t2" } },
  });
  assert.deepEqual(policy.reconciled(structural.token, ["w1:p1", "w1:p2"]), {
    current: true,
    resubscribe: true,
  });

  policy.beginSubscription(["w1:p1", "w1:p2"]);
  const replayedStructure = policy.handle({
    event: "pane.created",
    data: { pane: { pane_id: "w1:p2", tab_id: "w1:t2" } },
  });
  assert.deepEqual(policy.reconciled(replayedStructure.token, ["w1:p2", "w1:p1"]), {
    current: true,
    resubscribe: false,
  });
});
