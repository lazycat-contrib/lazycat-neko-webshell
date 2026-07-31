import assert from "node:assert/strict";
import test from "node:test";

import { scheduleHerdrAction } from "./herdr-action-scheduler.ts";
import { createHerdrInteractionQueue } from "./herdr-interaction-queue.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("resolves structural action options after preceding structural work", async () => {
  const first = deferred();
  const order = [];
  let focusedWorkspaceId = "w0";
  let optionResolutions = 0;
  const queue = createHerdrInteractionQueue();
  const active = scheduleHerdrAction(queue, {}, async () => {
    order.push("create-workspace-a");
    await first.promise;
  });
  const preceding = scheduleHerdrAction(queue, {}, async () => {
    focusedWorkspaceId = "w1";
    order.push("close-workspace-b");
  });
  const structural = scheduleHerdrAction(queue, () => {
    optionResolutions += 1;
    return { workspaceId: focusedWorkspaceId };
  }, async (options) => order.push(`create-tab:${options.workspaceId}`));
  const following = scheduleHerdrAction(queue, {}, async () => {
    focusedWorkspaceId = "w2";
    order.push("create-workspace-c");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["create-workspace-a"]);
  assert.equal(optionResolutions, 0);
  first.resolve();
  await Promise.all([active, preceding, structural, following]);

  assert.deepEqual(order, ["create-workspace-a", "close-workspace-b", "create-tab:w1", "create-workspace-c"]);
  assert.equal(optionResolutions, 1);
});
