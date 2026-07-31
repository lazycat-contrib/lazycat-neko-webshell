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

test("serializes structural actions in request order", async () => {
  const first = deferred();
  const order = [];
  const queue = createHerdrInteractionQueue();
  const active = queue.run(async () => {
    order.push("create-workspace");
    await first.promise;
  });
  const createTab = queue.run(async () => order.push("create-tab"));
  const closeWorkspace = queue.run(async () => order.push("close-workspace"));

  await Promise.resolve();
  assert.deepEqual(order, ["create-workspace"]);
  first.resolve();
  await Promise.all([active, createTab, closeWorkspace]);

  assert.deepEqual(order, ["create-workspace", "create-tab", "close-workspace"]);
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
