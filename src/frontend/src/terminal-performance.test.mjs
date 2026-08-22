import assert from "node:assert/strict";
import test from "node:test";
import {
  recordTerminalPerformance,
  resetTerminalPerformance,
  terminalPerformanceSnapshot,
} from "./terminal-performance.ts";

test("aggregates terminal hot-path timings and byte counts", () => {
  resetTerminalPerformance();
  recordTerminalPerformance("replayWrite", 4, 100);
  recordTerminalPerformance("replayWrite", 8, 200);
  assert.deepEqual(terminalPerformanceSnapshot().replayWrite, {
    count: 2,
    totalDurationMs: 12,
    maxDurationMs: 8,
    totalBytes: 300,
    averageDurationMs: 6,
  });
});
