import assert from "node:assert/strict";
import test from "node:test";
import {
  InstanceRequestError,
  createInstanceLoadCoordinator,
  instanceLoadErrorIsRetryable,
  loadInstancesWithRetry,
} from "./instance-loader.ts";

test("deduplicates discovery and prevents an aborted generation from winning", async () => {
  const pending = [];
  const coordinator = createInstanceLoadCoordinator((signal) => new Promise((resolve) => {
    pending.push({ resolve, signal });
  }));
  const first = coordinator.run();
  assert.equal(coordinator.run(), first);
  const second = coordinator.run({ restart: true });
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(["stale"]);
  pending[1].resolve(["fresh"]);
  assert.equal(await first, undefined);
  assert.deepEqual(await second, ["fresh"]);
});

test("cancels stale discovery and permits a fresh request later", async () => {
  const pending = [];
  const coordinator = createInstanceLoadCoordinator((signal) => new Promise((resolve) => {
    pending.push({ resolve, signal });
  }));
  const first = coordinator.run();
  coordinator.cancel();
  assert.equal(pending[0].signal.aborted, true);
  pending[0].resolve(["stale"]);
  assert.equal(await first, undefined);
  const second = coordinator.run();
  pending[1].resolve(["fresh"]);
  assert.deepEqual(await second, ["fresh"]);
});

test("retries transient discovery failures with bounded delays", async () => {
  const waits = [];
  let attempts = 0;
  const result = await loadInstancesWithRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw new InstanceRequestError("temporarily unavailable", 503);
    return ["instance-a"];
  }, {
    retryDelaysMs: [10, 20, 30],
    wait: async (delay) => { waits.push(delay); },
  });
  assert.deepEqual(result, ["instance-a"]);
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [10, 20]);
});

test("does not retry authentication or response decoding failures", async () => {
  for (const error of [new InstanceRequestError("unauthorized", 401), new Error("invalid response")]) {
    let attempts = 0;
    await assert.rejects(loadInstancesWithRetry(async () => {
      attempts += 1;
      throw error;
    }, { retryDelaysMs: [0], wait: async () => undefined }), error);
    assert.equal(attempts, 1);
  }
});

test("recognizes only transport and explicitly transient gateway failures as retryable", () => {
  assert.equal(instanceLoadErrorIsRetryable(new TypeError("fetch failed")), true);
  assert.equal(instanceLoadErrorIsRetryable(new InstanceRequestError("bad gateway", 502)), false);
  assert.equal(instanceLoadErrorIsRetryable(new InstanceRequestError("unavailable", 503)), true);
  assert.equal(instanceLoadErrorIsRetryable(new InstanceRequestError("timeout", 504)), true);
  assert.equal(instanceLoadErrorIsRetryable(new InstanceRequestError("not found", 404)), false);
});

test("aborts retry waits without making another request", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const promise = loadInstancesWithRetry(async () => {
    attempts += 1;
    throw new TypeError("offline");
  }, {
    signal: controller.signal,
    retryDelaysMs: [1000],
  });
  controller.abort();
  await assert.rejects(promise, { name: "AbortError" });
  assert.equal(attempts, 1);
});
