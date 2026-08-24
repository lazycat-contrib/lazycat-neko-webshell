import assert from "node:assert/strict";
import test from "node:test";
import { calculatePerformanceMeterSample } from "./performance-meter.ts";

test("calculates RAF cadence and p95 frame time without claiming hardware refresh rate", () => {
  assert.deepEqual(calculatePerformanceMeterSample(30, 500, [16.5, 16.7, 33]), {
    rafRate: 60,
    p95FrameTimeMs: 33,
  });
});

test("ignores invalid frame intervals", () => {
  assert.deepEqual(calculatePerformanceMeterSample(0, 0, [0, -1, 1000, Number.NaN]), {
    rafRate: 0,
    p95FrameTimeMs: 0,
  });
});
