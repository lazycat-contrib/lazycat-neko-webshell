export function renderMobileTouchSettingsView(): string {
  return `
              <div class="settings-group mobile-only-setting">
                <div class="settings-group-title" data-i18n="section.mobileTouchKeyboard">Touch &amp; system keyboard</div>
                <label class="field">
                  <span data-i18n="field.touchBehavior">Touch behavior</span>
                  <select id="touchSelectionMode">
                    <option value="long-press" data-i18n="touch.longPress">Pan first, long-press select</option>
                    <option value="drag" data-i18n="touch.drag">Drag to select</option>
                    <option value="off" data-i18n="touch.off">Touch selection off</option>
                  </select>
                </label>
                <p class="settings-help" data-i18n="setting.preventMobileKeyboardAutoOpenHelp">Keep Page Up, Page Down, and other shortcut keys from opening the system keyboard. Use the keyboard button or double-tap the terminal to open it.</p>
                <label class="switch">
                  <input id="preventMobileKeyboardAutoOpen" type="checkbox" />
                  <span data-i18n="setting.preventMobileKeyboardAutoOpen">Keep shortcut taps from opening the system keyboard</span>
                </label>
                <p class="settings-help settings-help-inline" data-i18n="setting.preventMobileKeyboardAutoOpenHelpShort">The keyboard button and a double-tap still open it when you want to type.</p>
              </div>
  `;
}
