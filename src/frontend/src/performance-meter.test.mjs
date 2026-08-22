import assert from "node:assert/strict";
import test from "node:test";
import { calculatePerformanceMeterSample } from "./performance-meter.ts";

test("calculates sampled FPS and median display refresh rate", () => {
  assert.deepEqual(calculatePerformanceMeterSample(30, 500, [16.5, 16.7, 33]), {
    fps: 60,
    refreshRate: 60,
  });
});

test("ignores invalid frame intervals", () => {
  assert.deepEqual(calculatePerformanceMeterSample(0, 0, [0, -1, 1000, Number.NaN]), {
    fps: 0,
    refreshRate: 0,
  });
});
