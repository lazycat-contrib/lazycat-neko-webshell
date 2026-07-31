import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrNavigationController } from "./herdr-navigation.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function bridgeState() {
  return {
    selector: "alpha@owner",
    available: true,
    supported_herdr_version: "0.7.5",
    supported_protocol: 17,
    socket_schema_version: 1,
    socket_source_revision: "test",
    workspaces: [
      { workspace_id: "w1", number: 1, label: "one", focused: true, active_tab_id: "t1", tab_count: 2, pane_count: 3, tokens: {} },
      { workspace_id: "w2", number: 2, label: "two", focused: false, active_tab_id: "t3", tab_count: 1, pane_count: 1, tokens: {} },
    ],
    tabs: [
      { tab_id: "t1", workspace_id: "w1", number: 1, label: "one", focused: true, pane_count: 1 },
      { tab_id: "t2", workspace_id: "w1", number: 2, label: "two", focused: false, pane_count: 2 },
      { tab_id: "t3", workspace_id: "w2", number: 1, label: "three", focused: false, pane_count: 1 },
    ],
    panes: [
      { pane_id: "p1", workspace_id: "w1", tab_id: "t1", focused: true, agent_status: "working", tokens: {} },
      { pane_id: "p2", workspace_id: "w1", tab_id: "t2", focused: false, agent_status: "idle", tokens: {} },
      { pane_id: "p3", workspace_id: "w1", tab_id: "t2", focused: false, agent_status: "idle", tokens: {} },
      { pane_id: "p4", workspace_id: "w2", tab_id: "t3", focused: false, agent_status: "idle", tokens: {} },
    ],
    agents: [],
  };
}

function navigationHarness(overrides = {}) {
  let state = bridgeState();
  const requests = [];
  const settled = [];
  const errors = [];
  const invalidations = [];
  const controller = createHerdrNavigationController({
    selectedSelector: () => "alpha@owner",
    selectedGeneration: () => 7,
    currentState: () => state,
    isCurrent: (selector, generation) => selector === "alpha@owner" && generation === 7,
    request: async (method, params, options) => {
      requests.push({ method, params, options });
      return { result: { ok: true } };
    },
    applyState: (next) => { state = next; },
    invalidate: () => invalidations.push("invalidate"),
    onSettled: (selector, target) => settled.push([selector, target]),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { controller, requests, settled, errors, invalidations, state: () => state };
}

test("sends tab focus immediately and applies the optimistic focus before the request completes", async () => {
  const pending = deferred();
  const harness = navigationHarness({
    request: async (method, params, options) => {
      harness.requests.push({ method, params, options });
      await pending.promise;
      return { result: { ok: true } };
    },
  });

  const focus = harness.controller.focusTab("t2");

  assert.deepEqual(harness.requests, [{
    method: "tab.focus",
    params: { tab_id: "t2" },
    options: { id: "lazycat-webshell:tab-focus", selector: "alpha@owner", mirrorNotification: false },
  }]);
  assert.deepEqual(harness.state().tabs.map((tab) => tab.focused), [false, true, false]);
  assert.deepEqual(harness.invalidations, ["invalidate"]);

  pending.resolve();
  await focus;
});

test("uses tab.focus for a single-pane target and pane.focus only for a split target", async () => {
  const single = navigationHarness();
  await single.controller.focusPane("p4");
  assert.deepEqual(single.requests[0], {
    method: "tab.focus",
    params: { tab_id: "t3" },
    options: { id: "lazycat-webshell:tab-focus", selector: "alpha@owner", mirrorNotification: false },
  });

  const split = navigationHarness();
  await split.controller.focusPane("p3");
  assert.deepEqual(split.requests[0], {
    method: "pane.focus",
    params: { pane_id: "p3" },
    options: { id: "lazycat-webshell:pane-focus", selector: "alpha@owner", mirrorNotification: false },
  });
});

test("uses the legacy agent.focus method for split panes before protocol 16", async () => {
  const harness = navigationHarness();
  harness.state().herdr_protocol = 14;

  await harness.controller.focusPane("p3");

  assert.deepEqual(harness.requests[0], {
    method: "agent.focus",
    params: { target: "p3" },
    options: { id: "lazycat-webshell:agent-focus", selector: "alpha@owner", mirrorNotification: false },
  });
});

test("does not queue a newer navigation click behind a slow request", async () => {
  const first = deferred();
  const harness = navigationHarness({
    request: async (method, params, options) => {
      harness.requests.push({ method, params, options });
      if (params.tab_id === "t2") await first.promise;
      return { result: { ok: true } };
    },
  });

  const focusFirst = harness.controller.focusTab("t2");
  const focusLatest = harness.controller.focusTab("t1");
  await focusLatest;

  assert.deepEqual(harness.requests.map((request) => request.params.tab_id), ["t2", "t1"]);
  assert.deepEqual(harness.state().tabs.map((tab) => tab.focused), [true, false, false]);

  first.resolve();
  await focusFirst;
  assert.deepEqual(harness.settled, [["alpha@owner", { kind: "tab", id: "t1" }]]);
});

test("ignores a stale navigation completion after the selected Herdr session changes", async () => {
  let selector = "alpha@owner";
  let generation = 7;
  const pending = deferred();
  const harness = navigationHarness({
    selectedSelector: () => selector,
    selectedGeneration: () => generation,
    isCurrent: (requestSelector, requestGeneration) => (
      requestSelector === selector && requestGeneration === generation
    ),
    request: async (method, params, options) => {
      harness.requests.push({ method, params, options });
      await pending.promise;
      return { result: { ok: true } };
    },
  });

  const focus = harness.controller.focusWorkspace("w2");
  selector = "beta@owner";
  generation = 8;
  pending.resolve();
  await focus;

  assert.deepEqual(harness.settled, []);
  assert.deepEqual(harness.errors, []);
});
