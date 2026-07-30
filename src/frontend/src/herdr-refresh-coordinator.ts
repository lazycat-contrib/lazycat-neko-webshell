type HerdrRefreshRequest = {
  selector: string;
  generation: number;
};

export function createHerdrRefreshCoordinator(
  run: (selector: string, generation: number) => Promise<boolean>,
) {
  let queued: HerdrRefreshRequest | undefined;
  let inFlight: Promise<boolean> | undefined;

  async function drain(): Promise<boolean> {
    let result = false;
    while (queued) {
      const request = queued;
      queued = undefined;
      result = await run(request.selector, request.generation);
    }
    return result;
  }

  return {
    refresh(selector: string, generation: number): Promise<boolean> {
      queued = { selector, generation };
      inFlight ??= drain().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    clearQueued() {
      queued = undefined;
    },
  };
}
