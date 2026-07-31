import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrInteractionQueue } from "./herdr-interaction-queue.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("does not coalesce navigation intents across structural actions", async () => {
  const first = deferred();
  const order = [];
  const queue = createHerdrInteractionQueue();
  const active = queue.runLatest("focus", async () => {
    order.push("focus-a");
    await first.promise;
  });
  const stale = queue.runLatest("focus", async () => order.push("focus-b"));
  const structural = queue.run(async () => order.push("create-tab"));
  const latest = queue.runLatest("focus", async () => order.push("focus-c"));

  await Promise.resolve();
  assert.deepEqual(order, ["focus-a"]);
  first.resolve();
  await Promise.all([active, stale, structural, latest]);

  assert.deepEqual(order, ["focus-a", "focus-b", "create-tab", "focus-c"]);
  assert.notEqual(await stale, undefined);
});

test("lets a structural action observe the navigation immediately before it", async () => {
  const first = deferred();
  const order = [];
  let focusedWorkspaceId = "w0";
  const queue = createHerdrInteractionQueue();
  const active = queue.runLatest("focus", async () => {
    order.push("focus-a");
    await first.promise;
  });
  const preceding = queue.runLatest("focus", async () => {
    focusedWorkspaceId = "w1";
    order.push("focus-b");
  });
  const structural = queue.run(async () => order.push(`create-tab:${focusedWorkspaceId}`));
  const following = queue.runLatest("focus", async () => {
    focusedWorkspaceId = "w2";
    order.push("focus-c");
  });

  await Promise.resolve();
  assert.deepEqual(order, ["focus-a"]);
  first.resolve();
  await Promise.all([active, preceding, structural, following]);

  assert.deepEqual(order, ["focus-a", "focus-b", "create-tab:w1", "focus-c"]);
});

test("continues with the next interaction after a failure", async () => {
  const order = [];
  const queue = createHerdrInteractionQueue();
  const failed = queue.run(async () => {
    order.push("failed");
    throw new Error("mutation failed");
  });
  const next = queue.run(async () => order.push("next"));

  await assert.rejects(failed, /mutation failed/);
  await next;
  assert.deepEqual(order, ["failed", "next"]);
});
