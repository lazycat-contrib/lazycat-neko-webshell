export const INSTANCE_RETRY_DELAYS_MS = [250, 750, 1500, 3000] as const;

import { HttpRequestError } from "./http-request-error.ts";

export { HttpRequestError as InstanceRequestError };

export type InstanceLoadOptions = {
  signal?: AbortSignal;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
};

export async function loadInstancesWithRetry<T>(
  load: (signal?: AbortSignal) => Promise<T>,
  options: InstanceLoadOptions = {},
): Promise<T> {
  const delays = options.retryDelaysMs ?? INSTANCE_RETRY_DELAYS_MS;
  const wait = options.wait ?? waitForRetry;
  let attempt = 0;
  while (true) {
    throwIfAborted(options.signal);
    try {
      return await load(options.signal);
    } catch (error) {
      throwIfAborted(options.signal);
      const delay = delays[attempt];
      if (delay === undefined || !instanceLoadErrorIsRetryable(error)) throw error;
      attempt += 1;
      options.onRetry?.(attempt, delay, error);
      await wait(delay, options.signal);
    }
  }
}

export function instanceLoadErrorIsRetryable(error: unknown): boolean {
  if (error instanceof HttpRequestError) {
    return error.status === 503 || error.status === 504;
  }
  return error instanceof TypeError;
}

export function createInstanceLoadCoordinator<T>(
  load: (signal?: AbortSignal) => Promise<T>,
) {
  let controller: AbortController | undefined;
  let inFlight: Promise<T | undefined> | undefined;
  let generation = 0;

  function run(options: InstanceLoadOptions & { restart?: boolean } = {}): Promise<T | undefined> {
    if (inFlight && !options.restart) return inFlight;
    if (options.restart) controller?.abort();
    const currentController = new AbortController();
    const currentGeneration = ++generation;
    controller = currentController;
    const request = loadInstancesWithRetry(load, {
      ...options,
      signal: currentController.signal,
    }).then((result) => (
      generation === currentGeneration && !currentController.signal.aborted ? result : undefined
    )).catch((error: unknown) => {
      if (currentController.signal.aborted || generation !== currentGeneration) return undefined;
      throw error;
    });
    const tracked = request.finally(() => {
      if (generation !== currentGeneration || inFlight !== tracked) return;
      controller = undefined;
      inFlight = undefined;
    });
    inFlight = tracked;
    return tracked;
  }

  function cancel(): void {
    generation += 1;
    controller?.abort();
    controller = undefined;
    inFlight = undefined;
  }

  return { run, cancel };
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason ?? new DOMException("Aborted", "AbortError");
}
