import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrAgentActions } from "./herdr-agent-actions.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("drops a captured Herdr focus before sending when the selector becomes stale", async () => {
  let selector = "alpha@owner";
  let generation = 4;
  const pending = deferred();
  const requests = [];
  const refreshed = [];
  const errors = [];
  const actions = createHerdrAgentActions({
    selectedSelector: () => selector,
    selectedGeneration: () => generation,
    requestFocus: async (request) => {
      requests.push(request);
      await pending.promise;
    },
    isCurrent: (requestSelector, requestGeneration) => (
      requestSelector === selector && requestGeneration === generation
    ),
    onFocused: (requestSelector) => refreshed.push(requestSelector),
    onError: (error) => errors.push(error),
  });

  const focus = actions.focus(" w1:p1 ");
  selector = "beta@owner";
  generation = 5;
  await focus;

  pending.resolve();
  assert.deepEqual(requests, []);
  assert.deepEqual(refreshed, []);
  assert.deepEqual(errors, []);
});

test("serializes pane focus requests and drops superseded queued clicks", async () => {
  const first = deferred();
  const requests = [];
  const actions = createHerdrAgentActions({
    selectedSelector: () => "alpha@owner",
    selectedGeneration: () => 1,
    requestFocus: async (request) => {
      requests.push(request.target);
      if (request.target === "p1") await first.promise;
    },
    isCurrent: () => true,
    onFocused: () => {},
    onError: () => {},
  });

  const focusFirst = actions.focus("p1");
  const focusSecond = actions.focus("p2");
  const focusThird = actions.focus("p3");
  await Promise.resolve();
  assert.deepEqual(requests, ["p1"]);
  first.resolve();
  await Promise.all([focusFirst, focusSecond, focusThird]);
  assert.deepEqual(requests, ["p1", "p3"]);
});

test("reports the focused pane target after a successful request", async () => {
  const focused = [];
  const actions = createHerdrAgentActions({
    selectedSelector: () => "alpha@owner",
    selectedGeneration: () => 1,
    requestFocus: async () => {},
    isCurrent: () => true,
    onFocused: (selector, target) => focused.push([selector, target]),
    onError: () => {},
  });

  await actions.focus(" w2:p2 ");

  assert.deepEqual(focused, [["alpha@owner", "w2:p2"]]);
});
