export type TerminalResizeTarget = object;

export type TerminalResizeSchedulerOptions<T extends TerminalResizeTarget> = {
  refresh: (target: T) => void;
  isVisible: (target: T) => boolean;
  settleDelayMs?: number;
  requestFrame?: (callback: FrameRequestCallback) => number;
  cancelFrame?: (handle: number) => void;
  setTimer?: (callback: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
};

type ScheduledResize = {
  generation: number;
  frame?: number;
  settleTimer?: number;
};

export function createTerminalResizeScheduler<T extends TerminalResizeTarget>(
  options: TerminalResizeSchedulerOptions<T>,
) {
  const requestFrame = options.requestFrame ?? window.requestAnimationFrame.bind(window);
  const cancelFrame = options.cancelFrame ?? window.cancelAnimationFrame.bind(window);
  const setTimer = options.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);
  const settleDelayMs = options.settleDelayMs ?? 180;
  const scheduled = new Map<T, ScheduledResize>();

  function schedule(target: T): void {
    if (!options.isVisible(target)) {
      cancel(target);
      return;
    }
    const state = scheduled.get(target) ?? { generation: 0 };
    state.generation += 1;
    const generation = state.generation;
    if (state.frame !== undefined) cancelFrame(state.frame);
    if (state.settleTimer !== undefined) clearTimer(state.settleTimer);
    state.frame = requestFrame(() => {
      state.frame = undefined;
      if (state.generation !== generation || !options.isVisible(target)) return;
      options.refresh(target);
    });
    state.settleTimer = setTimer(() => {
      state.settleTimer = undefined;
      if (state.generation !== generation) return;
      if (state.frame !== undefined) {
        cancelFrame(state.frame);
        state.frame = undefined;
      }
      if (options.isVisible(target)) options.refresh(target);
      scheduled.delete(target);
    }, settleDelayMs);
    scheduled.set(target, state);
  }

  function scheduleAll(targets: Iterable<T>): void {
    for (const target of targets) schedule(target);
  }

  function cancel(target: T): void {
    const state = scheduled.get(target);
    if (!state) return;
    state.generation += 1;
    if (state.frame !== undefined) cancelFrame(state.frame);
    if (state.settleTimer !== undefined) clearTimer(state.settleTimer);
    scheduled.delete(target);
  }

  function cancelAll(): void {
    for (const target of [...scheduled.keys()]) cancel(target);
  }

  return { schedule, scheduleAll, cancel, cancelAll };
}
