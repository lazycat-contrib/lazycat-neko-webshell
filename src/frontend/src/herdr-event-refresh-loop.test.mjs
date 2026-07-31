import assert from "node:assert/strict";
import test from "node:test";

import { createHerdrEventRefreshLoop } from "./herdr-event-refresh-loop.ts";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function fakeTimers() {
  let nextId = 1;
  const timers = new Map();
  return {
    set(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, delay });
      return id;
    },
    clear(id) {
      timers.delete(id);
    },
    delays() {
      return [...timers.values()].map((timer) => timer.delay);
    },
    fireNext() {
      const [id, timer] = timers.entries().next().value ?? [];
      assert.ok(timer, "expected a scheduled timer");
      timers.delete(id);
      timer.callback();
    },
  };
}

test("coalesces a busy Herdr stream without postponing the first refresh", async () => {
  const timers = fakeTimers();
  const first = deferred();
  const runs = [];
  const loop = createHerdrEventRefreshLoop({
    setTimer: timers.set,
    clearTimer: timers.clear,
    run: async (token) => {
      runs.push(token);
      if (runs.length === 1) return first.promise;
      return true;
    },
    retryDelay: () => 300,
  });

  loop.request(1);
  loop.request(2);
  loop.request(3);
  assert.deepEqual(timers.delays(), [120]);

  timers.fireNext();
  assert.deepEqual(runs, [3]);
  loop.request(4);
  loop.request(5);
  assert.deepEqual(timers.delays(), []);

  first.resolve(true);
  await first.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.delays(), [120]);

  timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runs, [3, 5]);
});

test("a new event accelerates a pending failure retry and reset cancels it", async () => {
  const timers = fakeTimers();
  const runs = [];
  const loop = createHerdrEventRefreshLoop({
    setTimer: timers.set,
    clearTimer: timers.clear,
    run: async (token) => {
      runs.push(token);
      return false;
    },
    retryDelay: (_token, attempt) => [300, 900][attempt] ?? 900,
  });

  loop.request(1);
  timers.fireNext();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(timers.delays(), [300]);

  loop.request(2);
  assert.deepEqual(timers.delays(), [120]);
  loop.reset();
  assert.deepEqual(timers.delays(), []);
  assert.deepEqual(runs, [1]);
});
