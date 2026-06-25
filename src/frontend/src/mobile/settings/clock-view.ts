export function renderMobileClockSettingsView(): string {
  return `
              <div class="settings-group">
                <div class="settings-group-title" data-i18n="section.mobileClock">Mobile clock</div>
                <p class="settings-help" data-i18n="setting.mobileClockHelp">Controls the time shown beside the mobile shortcut tabs.</p>
                <label class="switch">
                  <input id="mobileClockEnabled" type="checkbox" />
                  <span data-i18n="setting.mobileClockEnabled">Show mobile clock</span>
                </label>
                <label class="switch">
                  <input id="mobileClockUse24Hour" type="checkbox" />
                  <span data-i18n="setting.mobileClock24Hour">Use 24-hour time</span>
                </label>
                <label class="switch">
                  <input id="mobileClockShowPeriod" type="checkbox" />
                  <span data-i18n="setting.mobileClockPeriod">Show AM/PM</span>
                </label>
              </div>
  `;
}
