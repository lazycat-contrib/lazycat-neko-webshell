import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrRefreshCoordinator } from "./herdr-refresh-coordinator.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("coalesces equal refreshes and resolves a superseded queued request as stale", async () => {
  const first = deferred();
  const requests = [];
  const coordinator = createHerdrRefreshCoordinator(async (selector, generation) => {
    requests.push([selector, generation]);
    if (requests.length === 1) await first.promise;
    return true;
  });

  const active = coordinator.refresh("alpha", 1);
  const sharedActive = coordinator.refresh("alpha", 1);
  const superseded = coordinator.refresh("alpha", 2);
  const latest = coordinator.refresh("beta", 3);
  first.resolve();

  assert.equal(await active, true);
  assert.equal(await sharedActive, true);
  assert.equal(await superseded, false);
  assert.equal(await latest, true);
  assert.deepEqual(requests, [["alpha", 1], ["beta", 3]]);
});

test("runs a trailing refresh when Herdr state changes during an active request", async () => {
  const first = deferred();
  const requests = [];
  const coordinator = createHerdrRefreshCoordinator(async (selector, generation) => {
    requests.push([selector, generation]);
    if (requests.length === 1) await first.promise;
    return true;
  });

  const active = coordinator.refresh("alpha", 1, 7);
  const trailing = coordinator.refresh("alpha", 1, 8);
  first.resolve();

  assert.equal(await active, true);
  assert.equal(await trailing, true);
  assert.deepEqual(requests, [["alpha", 1], ["alpha", 1]]);
});
