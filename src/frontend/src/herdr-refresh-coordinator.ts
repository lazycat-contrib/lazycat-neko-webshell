type HerdrRefreshRequest = {
  selector: string;
  generation: number;
  promise: Promise<boolean>;
  resolve: (result: boolean) => void;
  reject: (error: unknown) => void;
};

export function createHerdrRefreshCoordinator(
  run: (selector: string, generation: number) => Promise<boolean>,
) {
  let active: HerdrRefreshRequest | undefined;
  let queued: HerdrRefreshRequest | undefined;

  function sameRequest(request: HerdrRefreshRequest, selector: string, generation: number): boolean {
    return request.selector === selector && request.generation === generation;
  }

  function start(request: HerdrRefreshRequest) {
    active = request;
    void run(request.selector, request.generation)
      .then(request.resolve, request.reject)
      .finally(() => {
        active = undefined;
        const next = queued;
        queued = undefined;
        if (next) start(next);
      });
  }

  function createRequest(selector: string, generation: number): HerdrRefreshRequest {
    let resolve: (result: boolean) => void = () => {};
    let reject: (error: unknown) => void = () => {};
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    return { selector, generation, promise, resolve, reject };
  }

  return {
    refresh(selector: string, generation: number): Promise<boolean> {
      if (active && sameRequest(active, selector, generation)) return active.promise;
      if (queued && sameRequest(queued, selector, generation)) return queued.promise;
      const request = createRequest(selector, generation);
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
