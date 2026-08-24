const SAMPLE_MS = 500;
const WARMUP_FRAMES = 12;
const MAX_INTERVALS = 90;

export type PerformanceMeterSample = {
  rafRate: number;
  p95FrameTimeMs: number;
};

export function calculatePerformanceMeterSample(
  frameCount: number,
  elapsedMs: number,
  frameIntervals: readonly number[],
): PerformanceMeterSample {
  const validIntervals = frameIntervals
    .filter((interval) => Number.isFinite(interval) && interval > 0 && interval < 1000)
    .sort((left, right) => left - right);
  const p95 = validIntervals.length > 0
    ? validIntervals[Math.max(0, Math.ceil(validIntervals.length * 0.95) - 1)]
    : 0;
  return {
    rafRate: elapsedMs > 0 ? Math.max(0, Math.round(frameCount * 1000 / elapsedMs)) : 0,
    p95FrameTimeMs: p95 > 0 ? Math.round(p95 * 10) / 10 : 0,
  };
}

export function createPerformanceMeter(root: HTMLElement) {
  let frame = 0;
  let enabled = false;
  let meter: HTMLDivElement | undefined;
  let rateLabel: HTMLSpanElement | undefined;
  let frameTimeLabel: HTMLSpanElement | undefined;

  function mount(): void {
    if (meter?.isConnected) return;
    meter = document.createElement("div");
    meter.className = "performance-meter";
    meter.setAttribute("aria-hidden", "true");
    rateLabel = document.createElement("span");
    frameTimeLabel = document.createElement("span");
    rateLabel.textContent = "RAF --/s";
    frameTimeLabel.textContent = "P95 -- ms";
    meter.append(rateLabel, frameTimeLabel);
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
        if (rateLabel) rateLabel.textContent = `RAF ${sample.rafRate}/s`;
        if (frameTimeLabel) frameTimeLabel.textContent = sample.p95FrameTimeMs > 0
          ? `P95 ${sample.p95FrameTimeMs.toFixed(1)} ms`
          : "P95 -- ms";
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
    rateLabel = undefined;
    frameTimeLabel = undefined;
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
