import assert from "node:assert/strict";
import test from "node:test";

import { createPaneConnectionScheduler } from "./pane-connection-scheduler.ts";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("limits concurrent connection starts and serves higher priority first", async () => {
  const started = [];
  const releases = new Map();
  const scheduler = createPaneConnectionScheduler({ capacity: 2 });
  scheduler.request("background", 1, () => {
    started.push("background");
    return new Promise((resolve) => releases.set("background", resolve));
  });
  scheduler.request("active", 10, () => {
    started.push("active");
    return new Promise((resolve) => releases.set("active", resolve));
  });
  scheduler.request("visible", 5, () => {
    started.push("visible");
    return new Promise((resolve) => releases.set("visible", resolve));
  });

  await flush();
  assert.deepEqual(started, ["active", "visible"]);
  releases.get("active")();
  await flush();
  releases.get("visible")();
  releases.get("background")();
  await scheduler.whenIdle();
  assert.deepEqual(started, ["active", "visible", "background"]);
});

test("deduplicates queued panes and keeps the latest priority", async () => {
  const started = [];
  let release;
  const scheduler = createPaneConnectionScheduler({ capacity: 1 });
  scheduler.request("first", 30, () => new Promise((resolve) => { release = resolve; }));
  scheduler.request("queued", 1, () => started.push("queued-high"));
  scheduler.reprioritize("queued", 20);

  await flush();
  assert.deepEqual(started, []);
  release();
  await scheduler.whenIdle();
  assert.deepEqual(started, ["queued-high"]);
});

test("cancels queued work without affecting an already running connection", async () => {
  let release;
  const started = [];
  const scheduler = createPaneConnectionScheduler({ capacity: 1 });
  scheduler.request("running", 10, () => new Promise((resolve) => { release = resolve; }));
  scheduler.request("cancelled", 20, () => started.push("cancelled"));
  scheduler.cancel("cancelled");
  await Promise.resolve();
  await Promise.resolve();
  release();
  await scheduler.whenIdle();

  assert.deepEqual(started, []);
});
