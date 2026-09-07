export function renderTerminalDiagnosticsSettings(): string {
  return `<div id="terminalDiagnostics" class="settings-group" hidden>
    <p class="settings-help" data-i18n="setting.terminalDiagnosticsHelp">Records connection timing and counters without terminal contents.</p>
    <div class="terminal-diagnostics-actions">
      <button type="button" class="command-button" data-diagnostics-copy data-i18n="action.copyTerminalDiagnostics">Copy terminal diagnostics</button>
      <button type="button" class="command-button" data-diagnostics-download data-i18n="action.downloadTerminalDiagnostics">Download terminal diagnostics</button>
    </div>
    <p class="field-status" data-diagnostics-status role="status"></p>
  </div>`;
}
