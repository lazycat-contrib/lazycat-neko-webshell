export function renderTerminalControlSettingsView(): string {
  return `
    <div class="settings-group terminal-control-settings">
      <div class="settings-group-title" data-i18n="section.terminalControl">Multi-device control</div>
      <label class="switch">
        <input id="terminalSingleControllerMode" type="checkbox" />
        <span data-i18n="setting.terminalSingleControllerMode">Use single controller mode</span>
      </label>
      <p class="settings-help" data-i18n="setting.terminalSingleControllerModeHelp">When enabled, new clients observe the current terminal size until they explicitly take control.</p>
    </div>
  `;
}
