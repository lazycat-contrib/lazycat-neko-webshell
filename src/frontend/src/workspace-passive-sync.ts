import { normalizeSelector } from "./workspace-selection.ts";

/** One unavailable target must not prevent the rest of a visible workspace from converging. */
export async function refreshWorkspaceSelectors(options: {
  selectors: Iterable<string>;
  signal: AbortSignal;
  skip: (selector: string) => boolean;
  refresh: (selector: string, signal: AbortSignal) => Promise<unknown>;
}): Promise<void> {
  const seen = new Set<string>();
  const errors: unknown[] = [];
  for (const value of options.selectors) {
    if (options.signal.aborted) return;
    const selector = normalizeSelector(value);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    if (options.skip(selector)) continue;
    try { await options.refresh(selector, options.signal); }
    catch (error) {
      if (options.signal.aborted) return;
      errors.push(error);
    }
  }
  if (!options.signal.aborted && errors.length) {
    throw new AggregateError(errors, "Workspace refresh failed");
  }
}

/** One request and one timer at most. All clock and browser effects are injected. */
export function createWorkspacePassiveSync(options: {
  enabled: () => boolean;
  refresh: (signal: AbortSignal) => Promise<void>;
  schedule: (callback: () => void, delay: number) => unknown;
  cancel: (timer: unknown) => void;
  intervalMs?: number;
  maxDelayMs?: number;
}) {
  const interval = Math.max(1000, options.intervalMs ?? 10000);
  const maximum = Math.max(interval, options.maxDelayMs ?? 60000);
  let timer: unknown;
  let request: AbortController | undefined;
  let disposed = false;
  let paused = false;
  let rerun = false;
  let delay = interval;
  function clearTimer() {
    if (timer !== undefined) options.cancel(timer);
    timer = undefined;
  }
  function schedule() {
    if (disposed || paused || !options.enabled()) return;
    timer = options.schedule(() => { timer = undefined; void run(); }, delay);
  }
  async function run() {
    if (disposed || paused || !options.enabled()) return;
    if (request) { rerun = true; return; }
    clearTimer();
    const current = new AbortController();
    request = current;
    try { await options.refresh(current.signal); delay = interval; }
    catch { if (!current.signal.aborted) delay = Math.min(maximum, delay * 2); }
    finally {
      request = undefined;
      if (!disposed && !paused && options.enabled()) {
        if (rerun) { rerun = false; void run(); }
        else schedule();
      }
    }
  }
  function pause() { paused = true; rerun = false; clearTimer(); request?.abort(); }
  return {
    pause,
    refresh() { void run(); },
    activityChanged() {
      clearTimer();
      if (!options.enabled()) pause();
      else { paused = false; void run(); }
    },
    dispose() { disposed = true; pause(); },
  };
}

export function bindWorkspacePassiveSync(
  controller: ReturnType<typeof createWorkspacePassiveSync>,
  windowTarget: Window,
  documentTarget: Document,
  onDispose: () => void,
) {
  const refresh = () => controller.activityChanged();
  const events = ["focus", "online", "offline", "pageshow"] as const;
  for (const event of events) windowTarget.addEventListener(event, refresh);
  documentTarget.addEventListener("visibilitychange", refresh);
  const dispose = (event: PageTransitionEvent) => {
    // A bfcache page must remain usable when restored.
    if (event.persisted) { controller.pause(); return; }
    controller.dispose();
    onDispose();
    for (const event of events) windowTarget.removeEventListener(event, refresh);
    documentTarget.removeEventListener("visibilitychange", refresh);
    windowTarget.removeEventListener("pagehide", dispose);
  };
  windowTarget.addEventListener("pagehide", dispose);
  controller.refresh();
}
