import "./styles.css";
import type { CommonResources, PluginEntry } from "../host";
import type { TerminalDiagnosticsResource } from "./types";
import { renderDiagnosticsTool } from "./tool-view";

export type EntryResources = CommonResources & {
  diagnostics: TerminalDiagnosticsResource;
  root: HTMLElement;
  refresh: () => void;
  download: (json: string) => void;
};

export function createEntry(resources: EntryResources): PluginEntry {
  let enabled = false;
  let status = "";
  let generation = 0;
  resources.root.addEventListener("click", async event => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-diagnostics-action]") : null;
    if (!button || !enabled || button.disabled) return;
    const current = ++generation;
    try {
      const json = JSON.stringify(resources.diagnostics.snapshot(), null, 2);
      if (button.dataset.terminalDiagnosticsAction === "copy") {
        await navigator.clipboard.writeText(json);
        if (current !== generation || !enabled) return;
        status = resources.tr("status.terminalDiagnosticsCopied");
      } else if (button.dataset.terminalDiagnosticsAction === "download") {
        resources.download(json);
      } else {
        status = "";
      }
    } catch {
      if (current !== generation || !enabled) return;
      status = resources.tr("status.terminalDiagnosticsExportFailed");
    }
    if (current === generation && enabled && resources.root.contains(button)) resources.refresh();
  });
  return {
    id: "terminal-diagnostics",
    configured(plugin) {
      enabled = plugin.enabled;
      resources.diagnostics.setEnabled(enabled);
      if (!enabled) { generation++; status = ""; }
    },
    render: plugin => renderDiagnosticsTool({
      snapshot: resources.diagnostics.snapshot(), disabled: resources.disabled(plugin), status, tr: resources.tr,
    }),
  };
}
export function renderSettings(): string { return ""; }
export function isSettingsOpen(): boolean { return false; }
