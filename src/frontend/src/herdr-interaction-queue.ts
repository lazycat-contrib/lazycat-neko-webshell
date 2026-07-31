export type HerdrInteractionQueue = {
  run<T>(task: () => Promise<T>): Promise<T>;
};

type QueuedInteraction = {
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export function createHerdrInteractionQueue(): HerdrInteractionQueue {
  let active = false;
  const queued: QueuedInteraction[] = [];

  function startNext() {
    if (active) return;
    const next = queued.shift();
    if (!next) return;
    active = true;
    void Promise.resolve()
      .then(next.task)
      .then(next.resolve, next.reject)
      .finally(() => {
        active = false;
        startNext();
      });
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    let resolve: (value: T) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    queued.push({
      task,
      resolve: (value) => resolve(value as T),
      reject,
    });
    startNext();
    return promise;
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return enqueue(task);
    },
  };
}
