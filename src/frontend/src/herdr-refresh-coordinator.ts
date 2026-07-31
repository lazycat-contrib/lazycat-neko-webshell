export type HerdrRefreshMode = "normal" | "preserve-available";

type HerdrRefreshRequest = {
  selector: string;
  generation: number;
  stateRevision: number;
  mode: HerdrRefreshMode;
  promise: Promise<boolean>;
  resolve: (result: boolean) => void;
  reject: (error: unknown) => void;
};

export function createHerdrRefreshCoordinator(
  run: (selector: string, generation: number, mode: HerdrRefreshMode) => Promise<boolean>,
) {
  let active: HerdrRefreshRequest | undefined;
  let queued: HerdrRefreshRequest | undefined;

  function sameRequest(
    request: HerdrRefreshRequest,
    selector: string,
    generation: number,
    stateRevision: number,
    mode: HerdrRefreshMode,
  ): boolean {
    return request.selector === selector
      && request.generation === generation
      && request.stateRevision === stateRevision
      && request.mode === mode;
  }

  function start(request: HerdrRefreshRequest) {
    active = request;
    void run(request.selector, request.generation, request.mode)
      .then(request.resolve, request.reject)
      .finally(() => {
        active = undefined;
        const next = queued;
        queued = undefined;
        if (next) start(next);
      });
  }

  function createRequest(
    selector: string,
    generation: number,
    stateRevision: number,
    mode: HerdrRefreshMode,
  ): HerdrRefreshRequest {
    let resolve: (result: boolean) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { selector, generation, stateRevision, mode, promise, resolve, reject };
  }

  return {
    refresh(
      selector: string,
      generation: number,
      stateRevision = 0,
      mode: HerdrRefreshMode = "normal",
    ): Promise<boolean> {
      if (active && sameRequest(active, selector, generation, stateRevision, mode)) return active.promise;
      if (queued && sameRequest(queued, selector, generation, stateRevision, mode)) return queued.promise;
      const request = createRequest(selector, generation, stateRevision, mode);
      if (active) {
        queued?.resolve(false);
        queued = request;
      } else {
        start(request);
      }
      return request.promise;
    },
    clearQueued() {
      queued?.resolve(false);
      queued = undefined;
    },
  };
}
