export type HerdrInteractionRunner = <T>(task: () => Promise<T>) => Promise<T | undefined>;

export type HerdrInteractionQueue = {
  run<T>(task: () => Promise<T>): Promise<T | undefined>;
  runLatest<T>(key: string, task: () => Promise<T>): Promise<T | undefined>;
};

type QueuedInteraction = {
  key?: string;
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

  function enqueue<T>(task: () => Promise<T>, key?: string): Promise<T | undefined> {
    let resolve: (value: T | undefined) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<T | undefined>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    if (key) {
      let staleIndex = -1;
      for (let index = queued.length - 1; index >= 0; index -= 1) {
        const item = queued[index];
        if (!item?.key) break;
        if (item.key === key) {
          staleIndex = index;
          break;
        }
      }
      if (staleIndex >= 0) {
        const [stale] = queued.splice(staleIndex, 1);
        stale?.resolve(undefined);
      }
    }
    queued.push({
      key,
      task,
      resolve: (value) => resolve(value as T),
      reject,
    });
    startNext();
    return promise;
  }

  return {
    run<T>(task: () => Promise<T>): Promise<T | undefined> {
      return enqueue(task);
    },
    runLatest<T>(key: string, task: () => Promise<T>): Promise<T | undefined> {
      return enqueue(task, key);
    },
  };
}
