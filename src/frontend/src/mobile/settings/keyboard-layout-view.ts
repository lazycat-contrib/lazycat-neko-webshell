export function renderMobileKeyboardLayoutSettingsView(): string {
  return `
    <div class="settings-group mobile-keyboard-layout-settings" id="mobileKeyboardLayoutSettings">
      <div class="settings-group-title" data-i18n="section.mobileKeyboardLayout">Shortcut layout</div>
      <p class="settings-help" data-i18n="setting.mobileKeyboardLayoutHelp">Choose a preset, switch categories, and arrange the keys as they should appear on the mobile shortcut bar. Editing a preset saves it as Custom.</p>
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
        <div class="field mobile-keyboard-page-field">
          <span data-i18n="field.mobileKeyboardPage">Shortcut category</span>
          <div class="mobile-keyboard-editor-tabs" role="tablist" data-mobile-layout-page-tabs>
            <button type="button" role="tab" id="mobileLayoutPageTabMain" aria-controls="mobileKeyboardLayoutPagePanel" data-mobile-layout-page-tab="main" aria-selected="true" data-i18n="label.mobileMainKeys">Main</button>
            <button type="button" role="tab" id="mobileLayoutPageTabOps" aria-controls="mobileKeyboardLayoutPagePanel" data-mobile-layout-page-tab="ops" aria-selected="false" data-i18n="label.mobileOpsKeys">Actions</button>
            <button type="button" role="tab" id="mobileLayoutPageTabNav" aria-controls="mobileKeyboardLayoutPagePanel" data-mobile-layout-page-tab="nav" aria-selected="false" data-i18n="label.mobileNavKeys">Navigation</button>
            <button type="button" role="tab" id="mobileLayoutPageTabFn" aria-controls="mobileKeyboardLayoutPagePanel" data-mobile-layout-page-tab="fn" aria-selected="false" data-i18n="label.mobileFnKeys">Function</button>
            <button type="button" role="tab" id="mobileLayoutPageTabSym" aria-controls="mobileKeyboardLayoutPagePanel" data-mobile-layout-page-tab="sym" aria-selected="false" data-i18n="label.mobileSymbolKeys">Symbols</button>
          </div>
        </div>
      </div>
      <div class="mobile-keyboard-width-legend" aria-label="Key width legend" data-i18n-aria="setting.mobileKeyboardWidthHelp">
        <span><i data-width="sm"></i><b data-i18n="option.mobileKeyboardWidthSmall">Narrow</b><small data-i18n="option.mobileKeyboardWidthSmallHint">one slot</small></span>
        <span><i data-width="md"></i><b data-i18n="option.mobileKeyboardWidthMedium">Standard</b><small data-i18n="option.mobileKeyboardWidthMediumHint">two slots</small></span>
        <span><i data-width="lg"></i><b data-i18n="option.mobileKeyboardWidthLarge">Wide</b><small data-i18n="option.mobileKeyboardWidthLargeHint">three slots</small></span>
      </div>
      <p class="settings-help settings-help-inline" data-i18n="setting.mobileKeyboardDragHelp">Drag a key to place it. Use the arrow buttons when you prefer precise keyboard control.</p>
      <div class="mobile-keyboard-key-list" id="mobileKeyboardLayoutPagePanel" role="tabpanel" aria-labelledby="mobileLayoutPageTabMain" data-mobile-layout-key-list></div>
      <details class="mobile-keyboard-custom-key">
        <summary data-i18n="action.mobileKeyboardAddKey">Add key</summary>
        <div class="mobile-keyboard-custom-key-fields">
          <label class="field"><span data-i18n="field.mobileKeyboardKeyType">Key type</span><select data-mobile-key-kind><option value="text" data-i18n="option.mobileKeyboardKeyText">Text</option><option value="shortcut" data-i18n="option.mobileKeyboardKeySpecial">Special key</option><option value="action" data-i18n="option.mobileKeyboardKeyAction">App action</option></select></label>
          <label class="field"><span data-i18n="field.mobileKeyboardKeyLabel">Label</span><input type="text" maxlength="24" data-mobile-key-label /></label>
          <label class="field" data-mobile-key-text-field><span data-i18n="field.mobileKeyboardKeyText">Text or escape sequence</span><textarea rows="2" maxlength="256" data-mobile-key-text></textarea><small data-i18n="setting.mobileKeyboardEscapeHelp">Use \\e or \\x1b for Escape; \\r, \\n and \\t are supported.</small></label>
          <label class="field" data-mobile-key-value-field hidden><span data-i18n="field.mobileKeyboardKeyValue">Key or action</span><select data-mobile-key-value></select></label>
          <label class="field"><span data-i18n="field.mobileKeyboardKeyWidth">Width</span><select data-mobile-key-new-width><option value="sm" data-i18n="option.mobileKeyboardWidthSmall">Narrow</option><option value="md" selected data-i18n="option.mobileKeyboardWidthMedium">Standard</option><option value="lg" data-i18n="option.mobileKeyboardWidthLarge">Wide</option></select></label>
          <label class="check-line" data-mobile-key-enter-field><input type="checkbox" data-mobile-key-enter /><span data-i18n="field.mobileKeyboardKeyEnter">Press Enter after sending this key's text</span></label>
          <p class="settings-help settings-help-inline" data-mobile-key-enter-help data-i18n="setting.mobileKeyboardKeyEnterHelp">Useful for commands that should run immediately.</p>
          <button class="command-button primary" type="button" data-mobile-key-add data-i18n="action.mobileKeyboardAddKey">Add key</button>
          <p class="field-status" data-mobile-layout-status aria-live="polite"></p>
        </div>
      </details>
      <button class="command-button" type="button" data-mobile-layout-reset data-i18n="action.mobileKeyboardRestoreDefault">Restore default</button>
    </div>
  `;
}
