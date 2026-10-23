import { createTerminalTrace } from "./terminal-trace.ts";
import { terminalPerformanceSnapshot } from "../terminal-performance.ts";
import type { TerminalDiagnosticsResource } from "../plugins/terminal-diagnostics/types";

export function createTerminalDiagnosticsResources() {
  const trace = createTerminalTrace();
  let debugEnabled = false;
  let pluginEnabled = false;
  const sync = () => trace.setEnabled(debugEnabled || pluginEnabled);
  const resource: TerminalDiagnosticsResource = {
    setEnabled(value) { pluginEnabled = value; sync(); },
    snapshot: () => ({ version: 1, trace: trace.snapshot(), performance: terminalPerformanceSnapshot() }),
  };
  return {
    resource,
    trace: {
      ...trace,
      setEnabled(value: boolean) { debugEnabled = value; sync(); },
    },
  };
}
