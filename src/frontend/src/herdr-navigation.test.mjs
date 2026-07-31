import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrInteractionQueue } from "./herdr-interaction-queue.ts";
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

function focusedTabState(tabId) {
  const state = bridgeState();
  const tab = state.tabs.find((item) => item.tab_id === tabId);
  const workspace = state.workspaces.find((item) => item.workspace_id === tab.workspace_id);
  for (const item of state.workspaces) item.focused = item === workspace;
  for (const item of state.tabs) item.focused = item === tab;
  workspace.active_tab_id = tabId;
  for (const pane of state.panes) pane.focused = pane.tab_id === tabId && pane === state.panes.find((item) => item.tab_id === tabId);
  return state;
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
    request: async (selector, action, options) => {
      requests.push({ selector, action, options });
      return state;
    },
    runSerial: (task) => task(),
    applyState: (next) => { state = next; },
    invalidate: () => invalidations.push("invalidate"),
    onSettled: (selector, target) => settled.push([selector, target]),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { controller, requests, settled, errors, invalidations, state: () => state };
}

test("applies the authoritative Herdr snapshot only after tab focus completes", async () => {
  const pending = deferred();
  const authoritative = focusedTabState("t2");
  const harness = navigationHarness({
    request: async (selector, action, options) => {
      harness.requests.push({ selector, action, options });
      return pending.promise;
    },
  });

  const focus = harness.controller.focusTab("t2");

  assert.deepEqual(harness.requests, [{
    selector: "alpha@owner",
    action: "focus_tab",
    options: { tabId: "t2" },
  }]);
  assert.deepEqual(harness.state().tabs.map((tab) => tab.focused), [true, false, false]);

  pending.resolve(authoritative);
  await focus;
  assert.deepEqual(harness.state().tabs.map((tab) => tab.focused), [false, true, false]);
  assert.deepEqual(harness.state().panes.map((pane) => pane.focused), [false, true, false, false]);
  assert.deepEqual(harness.invalidations, ["invalidate", "invalidate"]);
});

test("routes workspace, tab, and pane navigation through snapshot-returning actions", async () => {
  const harness = navigationHarness();

  await harness.controller.focusWorkspace(" w2 ");
  await harness.controller.focusTab(" t3 ");
  await harness.controller.focusPane(" p4 ");

  assert.deepEqual(harness.requests, [
    { selector: "alpha@owner", action: "focus_workspace", options: { workspaceId: "w2" } },
    { selector: "alpha@owner", action: "focus_tab", options: { tabId: "t3" } },
    { selector: "alpha@owner", action: "focus_pane", options: { paneId: "p4" } },
  ]);
});

test("serializes navigation so an older Herdr focus cannot finish after a newer click", async () => {
  const first = deferred();
  const queue = createHerdrInteractionQueue();
  const harness = navigationHarness({
    runSerial: (task) => queue.run(task),
    request: async (selector, action, options) => {
      harness.requests.push({ selector, action, options });
      if (options.tabId === "t2") return first.promise;
      return focusedTabState("t1");
    },
  });

  const focusFirst = harness.controller.focusTab("t2");
  const focusLatest = harness.controller.focusTab("t1");
  await Promise.resolve();
  assert.deepEqual(harness.requests.map((request) => request.options.tabId), ["t2"]);

  first.resolve(focusedTabState("t2"));
  await Promise.all([focusFirst, focusLatest]);

  assert.deepEqual(harness.requests.map((request) => request.options.tabId), ["t2", "t1"]);
  assert.deepEqual(harness.state().tabs.map((tab) => tab.focused), [true, false, false]);
});

test("ignores an authoritative snapshot after the selected Herdr session changes", async () => {
  let selector = "alpha@owner";
  let generation = 7;
  const pending = deferred();
  const harness = navigationHarness({
    selectedSelector: () => selector,
    selectedGeneration: () => generation,
    isCurrent: (requestSelector, requestGeneration) => (
      requestSelector === selector && requestGeneration === generation
    ),
    request: async () => pending.promise,
  });

  const focus = harness.controller.focusWorkspace("w2");
  selector = "beta@owner";
  generation = 8;
  pending.resolve(focusedTabState("t3"));
  await focus;

  assert.deepEqual(harness.state().tabs.map((tab) => tab.focused), [true, false, false]);
  assert.deepEqual(harness.settled, []);
  assert.deepEqual(harness.errors, []);
});
