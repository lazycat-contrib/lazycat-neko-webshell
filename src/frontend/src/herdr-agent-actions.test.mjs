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

test("focuses the captured Herdr selector and ignores a stale completion", async () => {
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
  pending.resolve();
  await focus;

  assert.deepEqual(requests, [{ selector: "alpha@owner", target: "w1:p1" }]);
  assert.deepEqual(refreshed, []);
  assert.deepEqual(errors, []);
});
