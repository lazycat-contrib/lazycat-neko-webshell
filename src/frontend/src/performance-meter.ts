const SAMPLE_MS = 500;
const WARMUP_FRAMES = 12;
const MAX_INTERVALS = 90;

export type PerformanceMeterSample = {
  fps: number;
  refreshRate: number;
};

export function calculatePerformanceMeterSample(
  frameCount: number,
  elapsedMs: number,
  frameIntervals: readonly number[],
): PerformanceMeterSample {
  const validIntervals = frameIntervals
    .filter((interval) => Number.isFinite(interval) && interval > 0 && interval < 1000)
    .sort((left, right) => left - right);
  const median = validIntervals.length > 0
    ? validIntervals[Math.floor(validIntervals.length / 2)]
    : 0;
  return {
    fps: elapsedMs > 0 ? Math.max(0, Math.round(frameCount * 1000 / elapsedMs)) : 0,
    refreshRate: median > 0 ? Math.max(0, Math.round(1000 / median)) : 0,
  };
}

export function createPerformanceMeter(root: HTMLElement) {
  let frame = 0;
  let enabled = false;
  let meter: HTMLDivElement | undefined;
  let fpsLabel: HTMLSpanElement | undefined;
  let refreshLabel: HTMLSpanElement | undefined;

  function mount(): void {
    if (meter?.isConnected) return;
    meter = document.createElement("div");
    meter.className = "performance-meter";
    meter.setAttribute("aria-hidden", "true");
    fpsLabel = document.createElement("span");
    refreshLabel = document.createElement("span");
    fpsLabel.textContent = "-- FPS";
    refreshLabel.textContent = "-- Hz";
    meter.append(fpsLabel, refreshLabel);
    root.appendChild(meter);
  }

  function start(): void {
    if (!enabled || frame || document.hidden) return;
    mount();
    let totalFrames = 0;
    let sampleFrames = 0;
    let sampleStart = 0;
    let lastTime = 0;
    const intervals: number[] = [];
    const update = (time: number) => {
      if (!enabled || document.hidden) {
        frame = 0;
        return;
      }
      totalFrames += 1;
      if (lastTime > 0) {
        const interval = time - lastTime;
        if (interval > 0 && interval < 1000) {
          intervals.push(interval);
          if (intervals.length > MAX_INTERVALS) intervals.shift();
        }
      }
      lastTime = time;
      if (totalFrames <= WARMUP_FRAMES) {
        sampleStart = time;
        sampleFrames = 0;
        frame = window.requestAnimationFrame(update);
        return;
      }
      sampleFrames += 1;
      const elapsed = time - sampleStart;
      if (elapsed >= SAMPLE_MS) {
        const sample = calculatePerformanceMeterSample(sampleFrames, elapsed, intervals);
        if (fpsLabel) fpsLabel.textContent = `${sample.fps} FPS`;
        if (refreshLabel) refreshLabel.textContent = sample.refreshRate > 0
          ? `${sample.refreshRate} Hz`
          : "-- Hz";
        sampleStart = time;
        sampleFrames = 0;
      }
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
  }

  function stop(): void {
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    meter?.remove();
    meter = undefined;
    fpsLabel = undefined;
    refreshLabel = undefined;
  }

  function setEnabled(next: boolean): void {
    enabled = next;
    if (enabled) start();
    else stop();
  }

  const handleVisibilityChange = () => {
    if (document.hidden) {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
    } else {
      start();
    }
  };
  document.addEventListener("visibilitychange", handleVisibilityChange);

  return {
    setEnabled,
    destroy: () => {
      enabled = false;
      stop();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    },
  };
}
