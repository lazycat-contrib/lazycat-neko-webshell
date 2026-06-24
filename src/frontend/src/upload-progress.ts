export type UploadProgressController = {
  start: () => void;
  set: (value: number) => void;
  finish: () => void;
  fail: () => void;
};

const HIDE_DELAY_MS = 520;

export function createUploadProgressController(root: HTMLElement): UploadProgressController {
  const element = document.createElement("div");
  element.className = "upload-progress";
  element.setAttribute("aria-hidden", "true");

  const bar = document.createElement("div");
  bar.className = "upload-progress-bar";
  element.append(bar);
  root.append(element);

  let hideTimer: number | undefined;
  let runId = 0;

  const apply = (value: number) => {
    const progress = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
    bar.style.transform = `scaleX(${progress})`;
  };

  return {
    start() {
      runId += 1;
      if (hideTimer !== undefined) {
        window.clearTimeout(hideTimer);
        hideTimer = undefined;
      }
      apply(0.04);
      element.classList.remove("failed");
      element.classList.add("visible");
    },
    set(value: number) {
      apply(value);
    },
    finish() {
      const currentRun = runId;
      apply(1);
      hideTimer = window.setTimeout(() => {
        if (currentRun !== runId) return;
        element.classList.remove("visible");
        apply(0);
      }, HIDE_DELAY_MS);
    },
    fail() {
      const currentRun = runId;
      element.classList.add("failed");
      apply(1);
      hideTimer = window.setTimeout(() => {
        if (currentRun !== runId) return;
        element.classList.remove("visible", "failed");
        apply(0);
      }, HIDE_DELAY_MS);
    },
  };
}
