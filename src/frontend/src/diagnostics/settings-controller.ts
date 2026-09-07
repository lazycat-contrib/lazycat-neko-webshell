import type { MessageKey } from "../i18n";
import type { createTerminalTrace } from "./terminal-trace.ts";

export function downloadTerminalDiagnostics(json: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "terminal-diagnostics.json";
  document.body.appendChild(link);
  try { link.click(); }
  finally { link.remove(); URL.revokeObjectURL(url); }
}

export function createTerminalDiagnosticsSettings(options: {
  root: HTMLElement;
  trace: ReturnType<typeof createTerminalTrace>;
  tr: (key: MessageKey) => string;
  copy?: (text: string) => Promise<void>;
  download?: (text: string) => void;
}) {
  const copy = options.root.querySelector<HTMLButtonElement>("[data-diagnostics-copy]")!;
  const download = options.root.querySelector<HTMLButtonElement>("[data-diagnostics-download]")!;
  const status = options.root.querySelector<HTMLElement>("[data-diagnostics-status]")!;
  let enabled = false;
  let disposed = false;
  let generation = 0;
  async function copyTrace() {
    if (!enabled || disposed) return;
    const current = ++generation;
    try {
      await (options.copy ?? (text => navigator.clipboard.writeText(text)))(options.trace.exportJSON());
      if (current === generation && enabled && !disposed) status.textContent = options.tr("status.terminalDiagnosticsCopied");
    } catch {
      if (current === generation && enabled && !disposed) status.textContent = options.tr("status.terminalDiagnosticsExportFailed");
    }
  }
  function downloadTrace() {
    if (!enabled || disposed) return;
    try { (options.download ?? downloadTerminalDiagnostics)(options.trace.exportJSON()); }
    catch { status.textContent = options.tr("status.terminalDiagnosticsExportFailed"); }
  }
  copy.addEventListener("click", copyTrace);
  download.addEventListener("click", downloadTrace);
  return {
    setEnabled(value: boolean) {
      if (disposed) return;
      enabled = value;
      options.trace.setEnabled(value);
      options.root.hidden = !value;
      if (!value) { generation++; status.textContent = ""; }
    },
    dispose() {
      if (disposed) return;
      disposed = true; enabled = false; generation++;
      copy.removeEventListener("click", copyTrace);
      download.removeEventListener("click", downloadTrace);
      options.root.hidden = true; status.textContent = "";
      options.trace.dispose();
    },
  };
}
