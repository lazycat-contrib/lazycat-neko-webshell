export const TERMINAL_TRACE_EVENTS = [
  "connect-requested", "socket-open", "socket-closed", "replay-validated",
  "replay-received", "replay-applied", "ready", "replay-gap", "overflow",
  "resize", "reconnect-scheduled", "error", "replay-timeout", "replay-interrupted",
] as const;
export type TerminalTraceEvent = typeof TERMINAL_TRACE_EVENTS[number];
export const TERMINAL_TRACE_REASONS = [
  "transport", "fatal", "offline", "identity-mismatch", "history-gap",
  "live-bytes", "live-sequences", "timeout", "replaced", "server",
] as const;
export type TerminalTraceReason = typeof TERMINAL_TRACE_REASONS[number];
const metricNames = ["bytes", "chunks", "bufferedBytes", "durationMs", "delayMs", "cols", "rows", "sequence", "closeCode"] as const;
export type TerminalTraceMetrics = Partial<Record<typeof metricNames[number], number>>;
export type TerminalTraceHook = (pane: object, event: TerminalTraceEvent, metrics?: TerminalTraceMetrics, reason?: TerminalTraceReason) => void;
export type TerminalTraceEntry = {
  atMs: number;
  generation: number;
  event: TerminalTraceEvent;
  metrics: TerminalTraceMetrics;
  reason?: TerminalTraceReason;
};
type PaneTrace = { pane: number; generation: number; dropped: number; events: TerminalTraceEntry[] };

const events = new Set<string>(TERMINAL_TRACE_EVENTS);
const reasons = new Set<string>(TERMINAL_TRACE_REASONS);
function capacity(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.trunc(value))) : fallback;
}

/** Anonymous IDs and an explicit schema: callers cannot export pane IDs, text, paths or URLs. */
export function createTerminalTrace(options: { now?: () => number; maxPanes?: number; maxEventsPerPane?: number } = {}) {
  const now = options.now ?? (() => performance.now());
  const maxPanes = capacity(options.maxPanes, 32, 128);
  const maxEvents = capacity(options.maxEventsPerPane, 128, 512);
  let enabled = false;
  let disposed = false;
  let owners = new WeakMap<object, number>();
  const panes = new Map<number, PaneTrace>();
  let nextPane = 0;
  let startedAt = 0;
  let lastTime = 0;
  function clear() { owners = new WeakMap(); panes.clear(); nextPane = 0; lastTime = 0; }
  const record: TerminalTraceHook = (owner, event, metrics, reason) => {
    if (!enabled || disposed || !events.has(event)) return;
    const paneId = owners.get(owner);
    let pane = paneId === undefined ? undefined : panes.get(paneId);
    if (!pane) {
      pane = { pane: ++nextPane, generation: 0, dropped: 0, events: [] };
      owners.set(owner, pane.pane);
    }
    panes.delete(pane.pane);
    panes.set(pane.pane, pane);
    while (panes.size > maxPanes) panes.delete(panes.keys().next().value!);
    if (event === "connect-requested") pane.generation++;
    const safeMetrics: TerminalTraceMetrics = {};
    for (const name of metricNames) {
      const value = metrics?.[name];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
        safeMetrics[name] = Math.min(Number.MAX_SAFE_INTEGER, value);
      }
    }
    const time = now() - startedAt;
    if (Number.isFinite(time)) lastTime = Math.max(lastTime, time, 0);
    const entry: TerminalTraceEntry = { atMs: lastTime, generation: pane.generation, event, metrics: safeMetrics };
    if (reason && reasons.has(reason)) entry.reason = reason;
    pane.events.push(entry);
    if (pane.events.length > maxEvents) { pane.events.shift(); pane.dropped++; }
  };
  function snapshot() {
    return { version: 1, enabled: enabled && !disposed, panes: [...panes.values()].map(pane => ({
      pane: pane.pane, generation: pane.generation, dropped: pane.dropped,
      events: pane.events.map(entry => ({ ...entry, metrics: { ...entry.metrics } })),
    })) };
  }
  return {
    record,
    snapshot,
    exportJSON: () => JSON.stringify(snapshot(), null, 2),
    setEnabled(value: boolean) {
      if (disposed || value === enabled) return;
      clear(); enabled = value;
      const time = enabled ? now() : 0;
      startedAt = Number.isFinite(time) ? time : 0;
    },
    forget(owner: object) {
      const paneId = owners.get(owner);
      if (paneId !== undefined) panes.delete(paneId);
      owners.delete(owner);
    },
    dispose() { disposed = true; enabled = false; clear(); },
  };
}
