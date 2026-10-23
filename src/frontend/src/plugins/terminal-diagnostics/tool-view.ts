import type { MessageKey } from "../../i18n";
import { escapeHtml } from "../../utils.ts";
import type { DiagnosticsSnapshot } from "./types";

export function renderDiagnosticsTool(state: {
  snapshot: DiagnosticsSnapshot;
  disabled: boolean;
  status: string;
  tr: (key: MessageKey) => string;
}): string {
  const { snapshot, tr } = state;
  const panes = snapshot.trace.panes;
  const events = panes.flatMap(pane => pane.events.map(event => ({ ...event, pane: pane.pane })))
    .sort((a, b) => b.atMs - a.atMs).slice(0, 40);
  const disabled = state.disabled ? "disabled" : "";
  return `<div class="plugin-tool terminal-diagnostics-tool">
    <div class="settings-group-title">${escapeHtml(tr("plugin.terminalDiagnostics.name"))}</div>
    <p class="settings-help">${escapeHtml(tr("diagnostics.help"))}</p>
    <div class="terminal-diagnostics-actions">
      <button type="button" class="command-button" data-terminal-diagnostics-action="refresh" ${disabled}>${escapeHtml(tr("action.refresh"))}</button>
      <button type="button" class="command-button" data-terminal-diagnostics-action="copy" ${disabled}>${escapeHtml(tr("action.copyTerminalDiagnostics"))}</button>
      <button type="button" class="command-button" data-terminal-diagnostics-action="download" ${disabled}>${escapeHtml(tr("action.downloadTerminalDiagnostics"))}</button>
    </div>
    <p class="field-status" role="status">${escapeHtml(state.status)}</p>
    <dl class="terminal-diagnostics-summary">
      <div><dt>${escapeHtml(tr("diagnostics.panes"))}</dt><dd>${panes.length}</dd></div>
      <div><dt>${escapeHtml(tr("diagnostics.events"))}</dt><dd>${panes.reduce((n, pane) => n + pane.events.length, 0)}</dd></div>
      <div><dt>${escapeHtml(tr("diagnostics.dropped"))}</dt><dd>${panes.reduce((n, pane) => n + pane.dropped, 0)}</dd></div>
    </dl>
    <div class="settings-group-title">${escapeHtml(tr("diagnostics.timings"))}</div>
    ${Object.entries(snapshot.performance).map(([name, entry]) => `<p class="settings-help">${escapeHtml(name)} · ${entry.count} · ${entry.averageDurationMs.toFixed(1)} ms (${escapeHtml(tr("diagnostics.maximum"))} ${entry.maxDurationMs.toFixed(1)} ms)</p>`).join("") || `<p class="settings-help">${escapeHtml(tr("diagnostics.empty"))}</p>`}
    <div class="settings-group-title">${escapeHtml(tr("diagnostics.timeline"))}</div>
    <p class="settings-help">${escapeHtml(tr("diagnostics.timelineHelp"))}</p>
    <ol class="terminal-diagnostics-timeline">${events.map(event => `<li><span>${event.atMs.toFixed(0)} ms · #${event.pane}/${event.generation}</span><code>${escapeHtml(event.event)}${event.reason ? ` · ${escapeHtml(event.reason)}` : ""}</code></li>`).join("")}</ol>
    ${events.length ? "" : `<p class="settings-help">${escapeHtml(tr("diagnostics.empty"))}</p>`}
  </div>`;
}
