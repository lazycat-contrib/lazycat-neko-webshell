type HerdrEventRefreshLoopOptions = {
  setTimer: (callback: () => void, delay: number) => number;
  clearTimer: (timer: number) => void;
  run: (token: number) => Promise<boolean>;
  retryDelay: (token: number, attempt: number) => number | undefined;
  debounceMs?: number;
};

type ScheduledKind = "debounce" | "retry";

export function createHerdrEventRefreshLoop(options: HerdrEventRefreshLoopOptions) {
  const debounceMs = options.debounceMs ?? 120;
  let epoch = 0;
  let latestToken: number | undefined;
  let timer: number | undefined;
  let scheduledKind: ScheduledKind | undefined;
  let runningEpoch: number | undefined;
  let retryAttempt = 0;

  function schedule(delay: number, kind: ScheduledKind) {
    scheduledKind = kind;
    timer = options.setTimer(() => {
      timer = undefined;
      scheduledKind = undefined;
      void runLatest();
    }, delay);
  }

  async function runLatest() {
    const runEpoch = epoch;
    const token = latestToken;
    if (token === undefined || runningEpoch === runEpoch) return;
    runningEpoch = runEpoch;

    let refreshed = false;
    try {
      refreshed = await options.run(token);
    } catch {
      refreshed = false;
    } finally {
      if (runningEpoch === runEpoch) runningEpoch = undefined;
    }
    if (epoch !== runEpoch) return;

    if (latestToken !== token) {
      retryAttempt = 0;
      schedule(debounceMs, "debounce");
      return;
    }
    if (refreshed) {
      retryAttempt = 0;
      return;
    }

    const delay = options.retryDelay(token, retryAttempt);
    retryAttempt += 1;
    if (delay !== undefined) schedule(delay, "retry");
  }

  return {
    request(token: number) {
      latestToken = token;
      retryAttempt = 0;
      if (runningEpoch === epoch) return;
      if (timer !== undefined) {
        if (scheduledKind !== "retry") return;
        options.clearTimer(timer);
        timer = undefined;
        scheduledKind = undefined;
      }
      schedule(debounceMs, "debounce");
    },

    reset() {
      epoch += 1;
      latestToken = undefined;
      retryAttempt = 0;
      if (timer !== undefined) options.clearTimer(timer);
      timer = undefined;
      scheduledKind = undefined;
    },
  };
}
