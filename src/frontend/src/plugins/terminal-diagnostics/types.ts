import type { createTerminalTrace } from "../../diagnostics/terminal-trace";
import type { terminalPerformanceSnapshot } from "../../terminal-performance";

export type DiagnosticsSnapshot = {
  version: 1;
  trace: ReturnType<ReturnType<typeof createTerminalTrace>["snapshot"]>;
  performance: ReturnType<typeof terminalPerformanceSnapshot>;
};

/** Only anonymized counters and timings cross the host boundary. */
export type TerminalDiagnosticsResource = {
  setEnabled: (enabled: boolean) => void;
  snapshot: () => DiagnosticsSnapshot;
};
