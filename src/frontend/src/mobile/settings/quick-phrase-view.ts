export function renderMobileQuickPhraseSettingsView(): string {
  return `
              <div class="settings-group" id="mobileQuickPhraseSettings">
                <div class="settings-group-title" data-i18n="section.mobileQuickInput">Mobile quick input</div>
                <p class="settings-help" data-i18n="setting.mobileQuickInputHelp">Save personal phrases for the mobile shortcut bar. They appear after Sym and are sorted by usage.</p>
                <div class="quick-phrase-list" id="mobileQuickPhraseList"></div>
                <div class="quick-phrase-editor">
                  <label class="field">
                    <span data-i18n="field.quickPhraseLabel">Label</span>
                    <input id="mobileQuickPhraseLabel" type="text" maxlength="32" autocomplete="off" />
                  </label>
                  <label class="field">
                    <span data-i18n="field.quickPhraseText">Text</span>
                    <textarea id="mobileQuickPhraseText" rows="2" maxlength="256"></textarea>
                  </label>
                  <div class="quick-phrase-actions">
                    <button class="command-button primary" id="mobileQuickPhraseSave" type="button" data-i18n="action.quickPhraseAdd">Add phrase</button>
                    <button class="command-button" id="mobileQuickPhraseCancel" type="button" data-i18n="action.quickPhraseCancel" hidden>Cancel</button>
                  </div>
                  <p id="mobileQuickPhraseStatus" class="field-status"></p>
                </div>
              </div>
  `;
}
