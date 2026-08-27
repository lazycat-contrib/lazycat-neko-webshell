type ConnectionTask = {
  key: string;
  priority: number;
  order: number;
  run: () => void | Promise<void>;
  onError?: (error: unknown) => void;
};

type Options = {
  capacity?: number;
};

export function createPaneConnectionScheduler(options: Options = {}) {
  const capacity = Math.max(1, Math.trunc(options.capacity ?? 3));
  const queued = new Map<string, ConnectionTask>();
  const running = new Set<string>();
  const idleWaiters: Array<() => void> = [];
  let nextOrder = 0;
  let drainScheduled = false;

  function request(
    key: string,
    priority: number,
    run: () => void | Promise<void>,
    onError?: (error: unknown) => void,
  ): void {
    const normalizedKey = key.trim();
    if (!normalizedKey || running.has(normalizedKey)) return;
    const existing = queued.get(normalizedKey);
    queued.set(normalizedKey, {
      key: normalizedKey,
      priority: Number.isFinite(priority) ? priority : 0,
      order: existing?.order ?? nextOrder++,
      run,
      onError,
    });
    scheduleDrain();
  }

  function cancel(key: string): void {
    queued.delete(key.trim());
    settleIdleIfReady();
  }

  function reprioritize(key: string, priority: number): void {
    const task = queued.get(key.trim());
    if (!task) return;
    task.priority = Number.isFinite(priority) ? priority : 0;
    scheduleDrain();
  }

  function drain(): void {
    while (running.size < capacity && queued.size > 0) {
      const task = [...queued.values()].sort((left, right) => (
        right.priority - left.priority || left.order - right.order
      ))[0];
      if (!task) break;
      queued.delete(task.key);
      running.add(task.key);
      Promise.resolve()
        .then(task.run)
        .catch((error: unknown) => task.onError?.(error))
        .finally(() => {
          running.delete(task.key);
          scheduleDrain();
          settleIdleIfReady();
        });
    }
  }

  function scheduleDrain(): void {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      drain();
    });
  }

  function settleIdleIfReady(): void {
    if (running.size > 0 || queued.size > 0) return;
    while (idleWaiters.length) idleWaiters.shift()?.();
  }

  function whenIdle(): Promise<void> {
    if (running.size === 0 && queued.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  return {
    request,
    cancel,
    reprioritize,
    whenIdle,
    activeCount: () => running.size,
    pendingCount: () => queued.size,
  };
}
