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
          <span class="mobile-shortcut-clock" id="mobileShortcutClock" role="timer" aria-label="Current time" data-i18n-aria="label.currentTime"></span>
        </div>
        <div class="mobile-keyboard-controls">
          <button type="button" class="mobile-system-keyboard-toggle" data-mobile-action="toggle-system-keyboard" aria-pressed="false" aria-label="Toggle system keyboard" title="Toggle system keyboard" data-i18n-aria="action.toggleSystemKeyboard" data-i18n-title="action.toggleSystemKeyboard"><i class="mobile-keyboard-hidden-icon" data-lucide="keyboard-off"></i><i class="mobile-keyboard-visible-icon" data-lucide="keyboard"></i></button>
          <div class="mobile-keyboard-panel" data-mobile-panel="main">
          <button type="button" data-mobile-shortcut="ctrl" data-mobile-modifier="ctrl" aria-label="Control">Ctrl</button>
          <button type="button" data-mobile-shortcut="alt" data-mobile-modifier="alt" aria-label="Alt">Alt</button>
          <button type="button" data-mobile-shortcut="shift" data-mobile-modifier="shift" aria-label="Shift">Shift</button>
          <button type="button" data-mobile-shortcut="tab" aria-label="Tab">Tab</button>
          <button type="button" data-mobile-shortcut="enter" data-mobile-repeat="true" aria-label="Return">Return</button>
          <button type="button" data-mobile-shortcut="left" data-mobile-repeat="true" aria-label="Left"><i data-lucide="arrow-left"></i></button>
          <button type="button" data-mobile-shortcut="down" data-mobile-repeat="true" aria-label="Down"><i data-lucide="arrow-down"></i></button>
          <button type="button" data-mobile-shortcut="up" data-mobile-repeat="true" aria-label="Up"><i data-lucide="arrow-up"></i></button>
          <button type="button" data-mobile-shortcut="right" data-mobile-repeat="true" aria-label="Right"><i data-lucide="arrow-right"></i></button>
          <button type="button" data-mobile-action="copy-selection" aria-label="Copy selection">Copy</button>
          <button type="button" data-mobile-shortcut="paste" aria-label="Paste"><i data-lucide="clipboard-paste"></i></button>
          <button type="button" data-mobile-action="pane-menu" aria-label="Pane menu">Menu</button>
          <button type="button" data-mobile-chord="ctrl-e" aria-label="Control E">Ctrl+E</button>
          <button type="button" data-mobile-chord="ctrl-c" aria-label="Control C">Ctrl+C</button>
          <button type="button" data-mobile-action="swap-pane" aria-label="Swap active pane">Swap</button>
          <button type="button" data-mobile-chord="shift-tab" aria-label="Shift Tab">Shift+Tab</button>
          <button type="button" data-mobile-shortcut="~" aria-label="Tilde">~</button>
          <button type="button" data-mobile-shortcut="/" aria-label="Slash">/</button>
          <button type="button" data-mobile-shortcut="-" aria-label="Hyphen">-</button>
          <button type="button" data-mobile-shortcut="$" aria-label="Dollar">$</button>
          <button type="button" data-mobile-shortcut="escape" aria-label="Escape">Esc</button>
        </div>
          <div class="mobile-keyboard-panel" data-mobile-panel="ops" hidden>
          <button type="button" data-mobile-action="previous-tab" aria-label="Previous terminal tab"><i data-lucide="chevron-left"></i><span>Tab</span></button>
          <button type="button" data-mobile-action="next-tab" aria-label="Next terminal tab"><span>Tab</span><i data-lucide="chevron-right"></i></button>
          <button type="button" data-mobile-action="new-tab" aria-label="New terminal tab"><i data-lucide="square-plus"></i></button>
          <button type="button" data-mobile-action="close-tab" aria-label="Close tab"><i data-lucide="square-x"></i></button>
          <button type="button" data-mobile-action="previous-pane" aria-label="Previous pane"><i data-lucide="chevron-left"></i><span>Pane</span></button>
          <button type="button" data-mobile-action="next-pane" aria-label="Next pane"><span>Pane</span><i data-lucide="chevron-right"></i></button>
          <button type="button" data-mobile-action="split-right" aria-label="Split right"><i data-lucide="panel-right"></i></button>
          <button type="button" data-mobile-action="split-down" aria-label="Split down"><i data-lucide="panel-bottom"></i></button>
          <button type="button" data-mobile-action="copy-selection" aria-label="Copy selection"><i data-lucide="copy"></i></button>
          <button type="button" data-mobile-action="paste-clipboard" aria-label="Paste"><i data-lucide="clipboard-paste"></i></button>
          <button type="button" data-mobile-action="font-larger" aria-label="Increase terminal font">A+</button>
          <button type="button" data-mobile-action="font-smaller" aria-label="Decrease terminal font">A-</button>
        </div>
          <div class="mobile-keyboard-panel" data-mobile-panel="nav" hidden>
          <button type="button" data-mobile-shortcut="home" data-mobile-repeat="true" aria-label="Home">Home</button>
          <button type="button" data-mobile-shortcut="end" data-mobile-repeat="true" aria-label="End">End</button>
          <button type="button" data-mobile-shortcut="pageUp" data-mobile-repeat="true" aria-label="Page up">PgUp</button>
          <button type="button" data-mobile-shortcut="pageDown" data-mobile-repeat="true" aria-label="Page down">PgDn</button>
          <button type="button" data-mobile-shortcut="insert" aria-label="Insert">Ins</button>
          <button type="button" data-mobile-shortcut="delete" data-mobile-repeat="true" aria-label="Delete">Del</button>
          <button type="button" data-mobile-shortcut="backspace" data-mobile-repeat="true" aria-label="Backspace">Bksp</button>
          <button type="button" data-mobile-shortcut="left" data-mobile-repeat="true" aria-label="Left"><i data-lucide="arrow-left"></i></button>
          <button type="button" data-mobile-shortcut="down" data-mobile-repeat="true" aria-label="Down"><i data-lucide="arrow-down"></i></button>
          <button type="button" data-mobile-shortcut="up" data-mobile-repeat="true" aria-label="Up"><i data-lucide="arrow-up"></i></button>
          <button type="button" data-mobile-shortcut="right" data-mobile-repeat="true" aria-label="Right"><i data-lucide="arrow-right"></i></button>
        </div>
          <div class="mobile-keyboard-panel" data-mobile-panel="fn" hidden>
          <button type="button" data-mobile-shortcut="f1" aria-label="F1">F1</button>
          <button type="button" data-mobile-shortcut="f2" aria-label="F2">F2</button>
          <button type="button" data-mobile-shortcut="f3" aria-label="F3">F3</button>
          <button type="button" data-mobile-shortcut="f4" aria-label="F4">F4</button>
          <button type="button" data-mobile-shortcut="f5" aria-label="F5">F5</button>
          <button type="button" data-mobile-shortcut="f6" aria-label="F6">F6</button>
          <button type="button" data-mobile-shortcut="f7" aria-label="F7">F7</button>
          <button type="button" data-mobile-shortcut="f8" aria-label="F8">F8</button>
          <button type="button" data-mobile-shortcut="f9" aria-label="F9">F9</button>
          <button type="button" data-mobile-shortcut="f10" aria-label="F10">F10</button>
          <button type="button" data-mobile-shortcut="f11" aria-label="F11">F11</button>
          <button type="button" data-mobile-shortcut="f12" aria-label="F12">F12</button>
        </div>
          <div class="mobile-keyboard-panel" data-mobile-panel="sym" hidden></div>
          <div class="mobile-keyboard-panel" data-mobile-panel="phrases" hidden></div>
        </div>
      </div>
  `;
}
