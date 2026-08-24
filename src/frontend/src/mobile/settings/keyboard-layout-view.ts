export function renderMobileKeyboardLayoutSettingsView(): string {
  return `
    <div class="settings-group mobile-keyboard-layout-settings" id="mobileKeyboardLayoutSettings">
      <div class="settings-group-title" data-i18n="section.mobileKeyboardLayout">Shortcut layout</div>
      <p class="settings-help" data-i18n="setting.mobileKeyboardLayoutHelp">Choose a preset or arrange the mobile shortcut pages. Editing a preset saves it as Custom.</p>
      <div class="mobile-keyboard-layout-toolbar">
        <label class="field">
          <span data-i18n="field.mobileKeyboardPreset">Preset</span>
          <select data-mobile-layout-preset>
            <option value="default" data-i18n="option.mobileKeyboardDefault">Default</option>
            <option value="operations" data-i18n="option.mobileKeyboardOperations">Operations</option>
            <option value="editor" data-i18n="option.mobileKeyboardEditor">Editor</option>
            <option value="custom" data-i18n="option.mobileKeyboardCustom">Custom</option>
          </select>
        </label>
        <label class="field">
          <span data-i18n="field.mobileKeyboardPage">Page</span>
          <select data-mobile-layout-page>
            <option value="main" data-i18n="label.mobileMainKeys">Main shortcuts</option>
            <option value="ops" data-i18n="label.mobileOpsKeys">Terminal actions</option>
            <option value="nav" data-i18n="label.mobileNavKeys">Navigation keys</option>
            <option value="fn" data-i18n="label.mobileFnKeys">Function keys</option>
            <option value="sym" data-i18n="label.mobileSymbolKeys">Symbols</option>
          </select>
        </label>
      </div>
      <div class="mobile-keyboard-key-list" data-mobile-layout-key-list></div>
      <details class="mobile-keyboard-custom-key">
        <summary data-i18n="action.mobileKeyboardAddKey">Add key</summary>
        <div class="mobile-keyboard-custom-key-fields">
          <label class="field"><span data-i18n="field.mobileKeyboardKeyType">Key type</span><select data-mobile-key-kind><option value="text" data-i18n="option.mobileKeyboardKeyText">Text</option><option value="shortcut" data-i18n="option.mobileKeyboardKeySpecial">Special key</option><option value="action" data-i18n="option.mobileKeyboardKeyAction">App action</option></select></label>
          <label class="field"><span data-i18n="field.mobileKeyboardKeyLabel">Label</span><input type="text" maxlength="24" data-mobile-key-label /></label>
          <label class="field" data-mobile-key-text-field><span data-i18n="field.mobileKeyboardKeyText">Text or escape sequence</span><textarea rows="2" maxlength="256" data-mobile-key-text></textarea><small data-i18n="setting.mobileKeyboardEscapeHelp">Use \\e or \\x1b for Escape; \\r, \\n and \\t are supported.</small></label>
          <label class="field" data-mobile-key-value-field hidden><span data-i18n="field.mobileKeyboardKeyValue">Key or action</span><select data-mobile-key-value></select></label>
          <label class="field"><span data-i18n="field.mobileKeyboardKeyWidth">Width</span><select data-mobile-key-new-width><option value="sm" data-i18n="option.mobileKeyboardWidthSmall">Small</option><option value="md" selected data-i18n="option.mobileKeyboardWidthMedium">Medium</option><option value="lg" data-i18n="option.mobileKeyboardWidthLarge">Large</option></select></label>
          <label class="check-line" data-mobile-key-enter-field><input type="checkbox" data-mobile-key-enter /><span data-i18n="field.mobileKeyboardKeyEnter">Send Enter after text</span></label>
          <button class="command-button primary" type="button" data-mobile-key-add data-i18n="action.mobileKeyboardAddKey">Add key</button>
          <p class="field-status" data-mobile-layout-status aria-live="polite"></p>
        </div>
      </details>
      <button class="command-button" type="button" data-mobile-layout-reset data-i18n="action.mobileKeyboardRestoreDefault">Restore default</button>
    </div>
  `;
}
