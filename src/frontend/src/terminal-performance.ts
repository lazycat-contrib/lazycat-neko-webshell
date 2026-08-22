export type TerminalPerformanceMetric = "replayWrite" | "resize" | "reconnectDelay";

export type TerminalPerformanceEntry = {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalBytes: number;
};

const entries = new Map<TerminalPerformanceMetric, TerminalPerformanceEntry>();

export function recordTerminalPerformance(
  metric: TerminalPerformanceMetric,
  durationMs: number,
  bytes = 0,
): void {
  const entry = entries.get(metric) ?? {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    totalBytes: 0,
  };
  const duration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  entry.count += 1;
  entry.totalDurationMs += duration;
  entry.maxDurationMs = Math.max(entry.maxDurationMs, duration);
  entry.totalBytes += Math.max(0, Math.trunc(bytes));
  entries.set(metric, entry);
}

export function terminalPerformanceSnapshot(): Record<string, TerminalPerformanceEntry & { averageDurationMs: number }> {
  return Object.fromEntries([...entries].map(([metric, entry]) => [metric, {
    ...entry,
    averageDurationMs: entry.count > 0 ? entry.totalDurationMs / entry.count : 0,
  }]));
}

export function resetTerminalPerformance(): void {
  entries.clear();
}
