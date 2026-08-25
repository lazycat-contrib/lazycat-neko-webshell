export function renderMobileClockSettingsView(): string {
  return `
              <div class="settings-group">
                <div class="settings-group-title" data-i18n="section.mobileClock">Mobile clock</div>
                <p class="settings-help" data-i18n="setting.mobileClockHelp">Controls the time shown beside the mobile shortcut tabs.</p>
                <label class="switch">
                  <input id="mobileClockEnabled" type="checkbox" />
                  <span data-i18n="setting.mobileClockEnabled">Show time beside shortcut tabs</span>
                </label>
                <p class="settings-help settings-help-inline" data-i18n="setting.mobileClockEnabledHelp">Useful when you want the current time visible without opening the system clock.</p>
                <label class="switch">
                  <input id="mobileClockUse24Hour" type="checkbox" />
                  <span data-i18n="setting.mobileClock24Hour">Use 24-hour format, for example 18:30</span>
                </label>
                <label class="switch">
                  <input id="mobileClockShowPeriod" type="checkbox" />
                  <span data-i18n="setting.mobileClockPeriod">Show AM/PM when using 12-hour format</span>
                </label>
              </div>
  `;
}
