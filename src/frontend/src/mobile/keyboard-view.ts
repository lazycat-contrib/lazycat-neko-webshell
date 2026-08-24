import { mobileKeyboardPresetLayout } from "./keyboard-layout.ts";
import { renderMobileKeyboardPanels } from "./keyboard-layout-view.ts";

export function renderMobileKeyboardView(): string {
  return `
      <div class="mobile-shortcuts" id="mobileShortcuts" role="region" aria-label="Terminal shortcuts" data-i18n-aria="menu.mobileShortcuts">
        <div class="mobile-keyboard-pages">
          <div class="mobile-keyboard-page-tabs" role="toolbar" aria-label="Terminal shortcut pages" data-i18n-aria="menu.mobileShortcuts">
            <button type="button" class="active" data-mobile-page="main" aria-pressed="true" aria-label="Main shortcuts" title="Main shortcuts" data-i18n-aria="label.mobileMainKeys" data-i18n-title="label.mobileMainKeys"><i data-lucide="keyboard"></i></button>
            <button type="button" data-mobile-page="ops" aria-pressed="false" aria-label="Terminal actions" title="Terminal actions" data-i18n-aria="label.mobileOpsKeys" data-i18n-title="label.mobileOpsKeys"><i data-lucide="sliders-horizontal"></i></button>
            <button type="button" data-mobile-page="nav" aria-pressed="false" aria-label="Navigation keys" title="Navigation keys" data-i18n-aria="label.mobileNavKeys" data-i18n-title="label.mobileNavKeys"><i data-lucide="navigation"></i></button>
            <button type="button" data-mobile-page="fn" aria-pressed="false" aria-label="Function keys" title="Function keys" data-i18n-aria="label.mobileFnKeys" data-i18n-title="label.mobileFnKeys"><i data-lucide="hash"></i></button>
            <button type="button" data-mobile-page="sym" aria-pressed="false" aria-label="Symbols" title="Symbols" data-i18n-aria="label.mobileSymbolKeys" data-i18n-title="label.mobileSymbolKeys"><i data-lucide="braces"></i></button>
          </div>
          <button type="button" class="mobile-system-keyboard-toggle" data-mobile-action="toggle-system-keyboard" aria-pressed="false" aria-label="Toggle system keyboard" title="Toggle system keyboard" data-i18n-aria="action.toggleSystemKeyboard" data-i18n-title="action.toggleSystemKeyboard"><i class="mobile-keyboard-hidden-icon" data-lucide="keyboard-off"></i><i class="mobile-keyboard-visible-icon" data-lucide="keyboard"></i></button>
          <span class="mobile-shortcut-clock" id="mobileShortcutClock" role="timer" aria-label="Current time" data-i18n-aria="label.currentTime"></span>
        </div>
        <div class="mobile-keyboard-controls">
          ${renderMobileKeyboardPanels(mobileKeyboardPresetLayout("default"))}
          <div class="mobile-keyboard-panel" data-mobile-panel="phrases" hidden></div>
        </div>
      </div>
  `;
}
