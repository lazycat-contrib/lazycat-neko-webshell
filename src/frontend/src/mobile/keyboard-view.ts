import { mobileKeyboardPresetLayout } from "./keyboard-layout.ts";
import { renderMobileKeyboardPanels } from "./keyboard-layout-view.ts";
import { renderMobileQuickBar } from "./quick-bar.ts";
import { renderMobileVirtualKeyboardPanels } from "./virtual-keyboard.ts";

export function renderMobileKeyboardView(): string {
  const layout = mobileKeyboardPresetLayout("default");
  return `
      <div class="mobile-shortcuts" id="mobileShortcuts" role="region" aria-label="Terminal shortcuts" data-i18n-aria="menu.mobileShortcuts" data-active-page="typing" data-expanded="false">
        <div class="mobile-keyboard-toolbar">
          <div class="mobile-keyboard-quick-keys" role="toolbar" aria-label="Quick terminal keys" data-i18n-aria="label.mobileQuickKeys">
            ${renderMobileQuickBar()}
          </div>
          <div class="mobile-keyboard-toolbar-actions">
            <button type="button" data-mobile-action="compose-text" aria-label="Draft input" title="Draft input" data-i18n-aria="mobileComposer.title" data-i18n-title="mobileComposer.title"><i data-lucide="message-square-text" aria-hidden="true"></i></button>
            <button type="button" class="mobile-secret-file-button" data-mobile-action="secret-file" aria-label="Secret file" title="Secret file" data-i18n-aria="secret.title" data-i18n-title="secret.title"><i data-lucide="file-key" aria-hidden="true"></i></button>
            <button type="button" class="mobile-system-keyboard-toggle" data-mobile-action="toggle-system-keyboard" aria-pressed="false" aria-label="Toggle system keyboard" title="Toggle system keyboard" data-i18n-aria="action.toggleSystemKeyboard" data-i18n-title="action.toggleSystemKeyboard"><i class="mobile-keyboard-hidden-icon" data-lucide="keyboard"></i><i class="mobile-keyboard-visible-icon" data-lucide="keyboard-off"></i></button>
            <button type="button" class="mobile-expand-keyboard-toggle" data-mobile-action="toggle-expanded-keyboard" aria-expanded="false" aria-controls="mobileExpandedKeyboard" aria-label="Expand keyboard" title="Expand keyboard" data-i18n-aria="action.expandMobileKeyboard" data-i18n-title="action.expandMobileKeyboard"><i class="mobile-keyboard-expand-icon" data-lucide="chevron-up" aria-hidden="true"></i><i class="mobile-keyboard-collapse-icon" data-lucide="chevron-down" aria-hidden="true"></i></button>
          </div>
        </div>
        <div class="mobile-expanded-keyboard" id="mobileExpandedKeyboard" hidden>
          <div class="mobile-keyboard-mode-tabs" role="toolbar" aria-label="Keyboard pages" data-i18n-aria="label.mobileKeyboardPages">
            <button type="button" class="active" data-mobile-page="typing" aria-pressed="true" data-i18n="label.mobileTypingKeys">ABC</button>
            <button type="button" data-mobile-page="function" aria-pressed="false" data-i18n="label.mobileFnKeys">Function</button>
            <button type="button" data-mobile-page="main" data-mobile-mode-tab="shortcuts" aria-pressed="false" data-i18n="menu.mobileShortcuts">Shortcuts</button>
            <button type="button" class="mobile-secret-file-secondary" data-mobile-action="secret-file" aria-label="Secret file" title="Secret file" data-i18n-aria="secret.title" data-i18n-title="secret.title"><i data-lucide="file-key" aria-hidden="true"></i></button>
          </div>
          <div class="mobile-virtual-keyboard-controls">
            ${renderMobileVirtualKeyboardPanels()}
          </div>
          <div class="mobile-keyboard-pages" hidden>
            <div class="mobile-keyboard-page-tabs" role="toolbar" aria-label="Terminal shortcut pages" data-i18n-aria="menu.mobileShortcuts">
              <button type="button" data-mobile-page="main" aria-pressed="false" aria-label="Main shortcuts" title="Main shortcuts" data-i18n-aria="label.mobileMainKeys" data-i18n-title="label.mobileMainKeys"><i data-lucide="command"></i></button>
              <button type="button" data-mobile-page="ops" aria-pressed="false" aria-label="Terminal actions" title="Terminal actions" data-i18n-aria="label.mobileOpsKeys" data-i18n-title="label.mobileOpsKeys"><i data-lucide="sliders-horizontal"></i></button>
              <button type="button" data-mobile-page="nav" aria-pressed="false" aria-label="Navigation keys" title="Navigation keys" data-i18n-aria="label.mobileNavKeys" data-i18n-title="label.mobileNavKeys"><i data-lucide="navigation"></i></button>
              <button type="button" data-mobile-page="fn" aria-pressed="false" aria-label="Function keys" title="Function keys" data-i18n-aria="label.mobileFnKeys" data-i18n-title="label.mobileFnKeys"><i data-lucide="hash"></i></button>
              <button type="button" data-mobile-page="sym" aria-pressed="false" aria-label="Symbols" title="Symbols" data-i18n-aria="label.mobileSymbolKeys" data-i18n-title="label.mobileSymbolKeys"><i data-lucide="braces"></i></button>
            </div>
            <span class="mobile-shortcut-clock" id="mobileShortcutClock" role="timer" aria-label="Current time" data-i18n-aria="label.currentTime"></span>
          </div>
          <div class="mobile-keyboard-controls" hidden>
            ${renderMobileKeyboardPanels(layout, "typing")}
            <div class="mobile-keyboard-panel" data-mobile-panel="phrases" hidden></div>
          </div>
        </div>
      </div>
  `;
}
