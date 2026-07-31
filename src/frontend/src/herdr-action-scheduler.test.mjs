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

test("resolves structural action options after preceding navigation", async () => {
  const first = deferred();
  const order = [];
  let focusedWorkspaceId = "w0";
  let optionResolutions = 0;
  const queue = createHerdrInteractionQueue();
  const active = scheduleHerdrAction(queue, "focus_workspace", {}, async () => {
    order.push("focus-a");
    await first.promise;
  });
  const preceding = scheduleHerdrAction(queue, "focus_workspace", {}, async () => {
    focusedWorkspaceId = "w1";
    order.push("focus-b");
  });
  const structural = scheduleHerdrAction(queue, "create_tab", () => {
    optionResolutions += 1;
    return { workspaceId: focusedWorkspaceId };
  }, async (options) => order.push(`create-tab:${options.workspaceId}`));
  const following = scheduleHerdrAction(queue, "focus_workspace", {}, async () => {
    focusedWorkspaceId = "w2";
    order.push("focus-c");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["focus-a"]);
  assert.equal(optionResolutions, 0);
  first.resolve();
  await Promise.all([active, preceding, structural, following]);

  assert.deepEqual(order, ["focus-a", "focus-b", "create-tab:w1", "focus-c"]);
  assert.equal(optionResolutions, 1);
});
