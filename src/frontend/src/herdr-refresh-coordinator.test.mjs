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

test("coalesces concurrent Herdr refreshes into the active and latest request", async () => {
  const first = deferred();
  const requests = [];
  const coordinator = createHerdrRefreshCoordinator(async (selector, generation) => {
    requests.push([selector, generation]);
    if (requests.length === 1) await first.promise;
    return true;
  });

  const active = coordinator.refresh("alpha", 1);
  const coalesced = coordinator.refresh("alpha", 2);
  coordinator.refresh("beta", 3);
  first.resolve();

  assert.equal(await active, true);
  assert.equal(await coalesced, true);
  assert.deepEqual(requests, [["alpha", 1], ["beta", 3]]);
});
