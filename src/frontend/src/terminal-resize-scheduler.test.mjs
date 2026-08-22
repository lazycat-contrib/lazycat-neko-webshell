import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalResizeScheduler } from "./terminal-resize-scheduler.ts";

function schedulerHarness() {
  let nextHandle = 1;
  const frames = new Map();
  const timers = new Map();
  const refreshed = [];
  const scheduler = createTerminalResizeScheduler({
    refresh: (target) => refreshed.push(target.id),
    isVisible: (target) => target.visible,
    requestFrame: (callback) => { const handle = nextHandle++; frames.set(handle, callback); return handle; },
    cancelFrame: (handle) => frames.delete(handle),
    setTimer: (callback) => { const handle = nextHandle++; timers.set(handle, callback); return handle; },
    clearTimer: (handle) => timers.delete(handle),
  });
  return {
    scheduler,
    refreshed,
    flushFrames: () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((run) => run(0)); },
    flushTimers: () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((run) => run()); },
    frameCount: () => frames.size,
    timerCount: () => timers.size,
  };
}

test("coalesces repeated resize requests into one frame and one settle refresh", () => {
  const harness = schedulerHarness();
  const pane = { id: "pane-1", visible: true };
  harness.scheduler.schedule(pane);
  harness.scheduler.schedule(pane);
  harness.scheduler.schedule(pane);
  assert.equal(harness.frameCount(), 1);
  assert.equal(harness.timerCount(), 1);
  harness.flushFrames();
  harness.flushTimers();
  assert.deepEqual(harness.refreshed, ["pane-1", "pane-1"]);
});

test("does not measure hidden panes and cancels stale work", () => {
  const harness = schedulerHarness();
  const pane = { id: "pane-1", visible: true };
  harness.scheduler.schedule(pane);
  pane.visible = false;
  harness.scheduler.schedule(pane);
  harness.flushFrames();
  harness.flushTimers();
  assert.deepEqual(harness.refreshed, []);
});
