import { qs } from "./utils";

export type ShellElements = {
  webshell: HTMLElement;
  topbar: HTMLElement;
  instanceList: HTMLDivElement;
  instanceSwitcher: HTMLDivElement;
  instanceButton: HTMLButtonElement;
  instanceMenu: HTMLDivElement;
  instanceStatusDot: HTMLSpanElement;
  refreshInstances: HTMLButtonElement;
  newTabButton: HTMLButtonElement;
  emptyNewTab: HTMLButtonElement;
  statusLine: HTMLParagraphElement;
  targetLabel: HTMLElement;
  tabList: HTMLDivElement;
  terminalStage: HTMLDivElement;
  mobileShortcuts: HTMLDivElement;
  emptyState: HTMLDivElement;
  homeButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  settingsMenu: HTMLDivElement;
  openSettingsItem: HTMLButtonElement;
  closeSettings: HTMLButtonElement;
  settingsPage: HTMLElement;
  settingsTabs: HTMLDivElement;
  fontTabs: HTMLDivElement;
  localeSelect: HTMLSelectElement;
  themeSelect: HTMLSelectElement;
  customThemeName: HTMLInputElement;
  customThemeSource: HTMLTextAreaElement;
  saveTheme: HTMLButtonElement;
  removeTheme: HTMLButtonElement;
  themeStatus: HTMLElement;
  fontFamily: HTMLSelectElement;
  fontPreview: HTMLDivElement;
  tabLayout: HTMLSelectElement;
  fontUpload: HTMLInputElement;
  removeFont: HTMLButtonElement;
  fontStatus: HTMLElement;
  fontSize: HTMLInputElement;
  fontSizeValue: HTMLOutputElement;
  lineHeight: HTMLInputElement;
  lineHeightValue: HTMLOutputElement;
  scrollbackLimit: HTMLInputElement;
  outputBufferLimit: HTMLInputElement;
  cursorBlink: HTMLInputElement;
  cursorShape: HTMLSelectElement;
  copyOnSelect: HTMLInputElement;
  useResttyClipboard: HTMLInputElement;
  touchSelectionMode: HTMLSelectElement;
  autoRestartSessions: HTMLInputElement;
  debugMode: HTMLInputElement;
  paneMenu: HTMLDivElement;
  fitTerminal: HTMLButtonElement;
};

export function renderShell(app: HTMLElement): ShellElements {
  app.innerHTML = `
    <main class="webshell" id="webshell" aria-label="LazyCat Neko WebShell workspace" data-i18n-aria="app.title">
      <header class="topbar" aria-label="Terminal controls" data-i18n-aria="app.title">
        <div class="tabs-shell">
          <div id="tabList" class="tab-list" role="tablist" aria-label="Terminal tabs" data-i18n-aria="action.newTab"></div>
          <button class="tab-add" id="newTabButton" type="button" aria-label="New terminal tab" title="New terminal tab" data-i18n-aria="action.newTab" data-i18n-title="action.newTab">
            <i data-lucide="plus"></i>
          </button>
        </div>
        <div class="topbar-actions">
          <div class="instance-switcher" id="instanceSwitcher">
            <button class="icon-button status-icon" id="instanceButton" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Switch instance" title="Switch instance" data-i18n-aria="action.switchInstance" data-i18n-title="action.switchInstance">
              <span class="status-dot" id="instanceStatusDot" data-status="unknown"></span>
              <i data-lucide="server"></i>
              <span id="targetLabel" class="sr-only" data-i18n="status.noTarget">No instance selected</span>
            </button>
            <div class="switcher-menu" id="instanceMenu" hidden>
              <div class="menu-head">
                <span data-i18n="menu.instances">Instances</span>
                <button class="icon-button" id="refreshInstances" type="button" aria-label="Refresh instances" title="Refresh instances" data-i18n-aria="action.refreshInstances" data-i18n-title="action.refreshInstances">
                  <i data-lucide="refresh-cw"></i>
                </button>
              </div>
              <div id="instanceList" class="instance-list" role="listbox" aria-label="Running instances" aria-live="polite"></div>
            </div>
          </div>
          <button class="icon-button" id="fitTerminal" type="button" aria-label="Full screen" title="Full screen" data-i18n-aria="action.fullscreen" data-i18n-title="action.fullscreen">
            <i data-lucide="maximize"></i>
          </button>
          <div class="settings-menu-shell" id="settingsMenuShell">
            <button class="icon-button" id="settingsButton" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Settings menu" title="Settings menu" data-i18n-aria="action.settingsMenu" data-i18n-title="action.settingsMenu">
              <i data-lucide="menu"></i>
            </button>
            <div class="settings-menu" id="settingsMenu" role="menu" aria-label="Settings menu" data-i18n-aria="action.settingsMenu" hidden>
              <button id="openSettingsItem" type="button" role="menuitem">
                <i data-lucide="settings"></i>
                <span data-i18n="action.settings">Settings</span>
              </button>
              <button id="homeButton" type="button" role="menuitem">
                <i data-lucide="house"></i>
                <span data-i18n="action.lightosHome">LightOS home</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <section id="terminalStage" class="terminal-stage" aria-label="Terminal" data-i18n-aria="app.title">
        <div class="empty-state" id="emptyState">
          <button class="command-button primary icon-only-large" id="emptyNewTab" type="button" aria-label="New terminal tab" title="New terminal tab" data-i18n-aria="action.newTab" data-i18n-title="action.newTab">
            <i data-lucide="square-plus"></i>
          </button>
          <p id="statusLine" aria-live="polite" data-i18n="status.idle">Idle</p>
        </div>
        <div class="mobile-shortcuts" id="mobileShortcuts" aria-label="Terminal shortcuts" data-i18n-aria="menu.mobileShortcuts">
          <button type="button" data-mobile-shortcut="escape" aria-label="Escape">Esc</button>
          <button type="button" data-mobile-shortcut="tab" aria-label="Tab">Tab</button>
          <button type="button" data-mobile-shortcut="ctrl" data-mobile-modifier="ctrl" aria-label="Control">Ctrl</button>
          <button type="button" data-mobile-shortcut="alt" data-mobile-modifier="alt" aria-label="Alt">Alt</button>
          <button type="button" data-mobile-shortcut="shift" data-mobile-modifier="shift" aria-label="Shift">Shift</button>
          <button type="button" data-mobile-shortcut="left" data-mobile-repeat="true" aria-label="Left"><i data-lucide="arrow-left"></i></button>
          <button type="button" data-mobile-shortcut="down" data-mobile-repeat="true" aria-label="Down"><i data-lucide="arrow-down"></i></button>
          <button type="button" data-mobile-shortcut="up" data-mobile-repeat="true" aria-label="Up"><i data-lucide="arrow-up"></i></button>
          <button type="button" data-mobile-shortcut="right" data-mobile-repeat="true" aria-label="Right"><i data-lucide="arrow-right"></i></button>
          <button type="button" data-mobile-shortcut="enter" data-mobile-repeat="true" aria-label="Enter"><i data-lucide="corner-down-left"></i></button>
          <button type="button" data-mobile-shortcut="paste" aria-label="Paste"><i data-lucide="clipboard-paste"></i></button>
        </div>
      </section>

      <section class="settings-page" id="settingsPage" hidden aria-label="Settings" data-i18n-aria="action.settings">
        <div class="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
          <header class="settings-header">
            <div>
              <h2 id="settingsTitle" data-i18n="action.settings">Settings</h2>
            </div>
            <button class="icon-button" id="closeSettings" type="button" aria-label="Close settings" title="Close settings" data-i18n-aria="action.closeSettings" data-i18n-title="action.closeSettings">
              <i data-lucide="x"></i>
            </button>
          </header>

          <div class="settings-tabs settings-main-tabs" id="settingsTabs" role="tablist" aria-label="Settings" data-i18n-aria="action.settings">
            <button type="button" role="tab" aria-selected="true" aria-controls="appearanceSettingsPanel" data-settings-tab="appearance">
              <i data-lucide="monitor-cog"></i>
              <span data-i18n="tab.appearance">Appearance</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="fontSettingsRootPanel" data-settings-tab="fonts">
              <i data-lucide="type"></i>
              <span data-i18n="tab.fonts">Fonts</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="themeSettingsPanel" data-settings-tab="themes">
              <i data-lucide="palette"></i>
              <span data-i18n="tab.themes">Themes</span>
            </button>
          </div>

          <div class="settings-panels">
            <section class="settings-section" id="appearanceSettingsPanel" data-settings-panel="appearance" role="tabpanel">
              <label class="field">
                <span data-i18n="field.language">Language</span>
                <select id="localeSelect">
                  <option value="auto" data-i18n="locale.auto">Auto</option>
                  <option value="en" data-i18n="locale.en">English</option>
                  <option value="zh-CN" data-i18n="locale.zhCN">Chinese</option>
                </select>
              </label>
              <label class="field">
                <span data-i18n="field.tabs">Tabs</span>
                <select id="tabLayout">
                  <option value="horizontal" data-i18n="layout.horizontal">Horizontal</option>
                  <option value="vertical" data-i18n="layout.vertical">Vertical</option>
                </select>
              </label>
              <label class="field">
                <span data-i18n="field.cursor">Cursor</span>
                <select id="cursorShape">
                  <option value="block" data-i18n="cursor.block">Block</option>
                  <option value="bar" data-i18n="cursor.bar">Bar</option>
                  <option value="underline" data-i18n="cursor.underline">Underline</option>
                </select>
              </label>
              <label class="field">
                <span data-i18n="field.scrollback">Scrollback</span>
                <input id="scrollbackLimit" type="number" min="1000" max="100000" step="1000" />
              </label>
              <label class="field">
                <span data-i18n="field.outputBuffer">Output buffer</span>
                <input id="outputBufferLimit" type="number" min="128" max="20000" step="128" />
              </label>
              <label class="switch">
                <input id="cursorBlink" type="checkbox" />
                <span data-i18n="setting.cursorBlink">Cursor blink</span>
              </label>
              <label class="switch">
                <input id="copyOnSelect" type="checkbox" />
                <span data-i18n="setting.copyOnSelect">Copy on select</span>
              </label>
              <label class="switch">
                <input id="useResttyClipboard" type="checkbox" />
                <span data-i18n="setting.useResttyClipboard">Use restty clipboard</span>
              </label>
              <label class="field mobile-only-setting">
                <span data-i18n="field.touchBehavior">Touch behavior</span>
                <select id="touchSelectionMode">
                  <option value="long-press" data-i18n="touch.longPress">Pan first, long-press select</option>
                  <option value="drag" data-i18n="touch.drag">Drag to select</option>
                  <option value="off" data-i18n="touch.off">Touch selection off</option>
                </select>
              </label>
              <label class="switch">
                <input id="autoRestartSessions" type="checkbox" />
                <span data-i18n="setting.autoRestartSessions">Restart sessions after provider restart</span>
              </label>
              <label class="switch">
                <input id="debugMode" type="checkbox" />
                <span data-i18n="setting.debugAdapter">Debug adapter</span>
              </label>
            </section>

            <section class="settings-section" id="fontSettingsRootPanel" data-settings-panel="fonts" role="tabpanel" hidden>
              <div class="settings-tabs settings-sub-tabs" id="fontTabs" role="tablist" aria-label="Fonts" data-i18n-aria="section.fonts">
                <button type="button" role="tab" aria-selected="true" aria-controls="fontSettingsPanel" data-font-tab="font-settings" data-i18n="tab.fontSettings">Font settings</button>
                <button type="button" role="tab" aria-selected="false" aria-controls="fontUploadPanel" data-font-tab="font-upload" data-i18n="tab.fontUpload">Font upload</button>
              </div>
              <div class="settings-tab-panel" id="fontSettingsPanel" data-font-panel="font-settings" role="tabpanel">
                <label class="field">
                  <span data-i18n="field.font">Font</span>
                  <select id="fontFamily"></select>
                </label>
                <div class="font-preview" id="fontPreview" aria-label="Font preview" data-i18n-aria="field.fontPreview">
                  <span>LazyCat Neko WebShell</span>
                  <code>λ ~/app $ ls -la --color=auto 0123456789</code>
                </div>
                <label class="field">
                  <span><span data-i18n="field.fontSize">Font size</span> <output id="fontSizeValue"></output></span>
                  <input id="fontSize" type="range" min="11" max="22" step="1" />
                </label>
                <label class="field">
                  <span><span data-i18n="field.lineHeight">Line height</span> <output id="lineHeightValue"></output></span>
                  <input id="lineHeight" type="range" min="1.05" max="1.6" step="0.01" />
                </label>
              </div>
              <div class="settings-tab-panel" id="fontUploadPanel" data-font-panel="font-upload" role="tabpanel" hidden>
                <div class="font-actions">
                  <label class="file-button icon-only-large" aria-label="Upload font" title="Upload font" data-i18n-aria="action.uploadFont" data-i18n-title="action.uploadFont">
                    <input id="fontUpload" type="file" accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf" />
                    <i data-lucide="upload"></i>
                  </label>
                  <button class="command-button icon-only-large" id="removeFont" type="button" aria-label="Remove selected font" title="Remove selected font" data-i18n-aria="action.removeFont" data-i18n-title="action.removeFont">
                    <i data-lucide="trash-2"></i>
                  </button>
                </div>
                <p id="fontStatus" class="field-status"></p>
              </div>
            </section>

            <section class="settings-section" id="themeSettingsPanel" data-settings-panel="themes" role="tabpanel" hidden>
              <label class="field">
                <span data-i18n="field.theme">Theme</span>
                <select id="themeSelect"></select>
              </label>
              <a class="settings-link" href="https://ghostty-style.vercel.app" target="_blank" rel="noreferrer">
                <i data-lucide="external-link"></i>
                <span data-i18n="theme.gallery">Ghostty Style Gallery</span>
              </a>
              <label class="field">
                <span data-i18n="field.themeName">Theme name</span>
                <input id="customThemeName" type="text" autocomplete="off" spellcheck="false" />
              </label>
              <label class="field">
                <span data-i18n="field.themeSource">Ghostty theme</span>
                <textarea id="customThemeSource" spellcheck="false" rows="10"></textarea>
              </label>
              <div class="theme-actions">
                <button class="command-button" id="saveTheme" type="button">
                  <i data-lucide="save"></i>
                  <span data-i18n="action.saveTheme">Save custom theme</span>
                </button>
                <button class="command-button" id="removeTheme" type="button">
                  <i data-lucide="trash-2"></i>
                  <span data-i18n="action.removeTheme">Remove custom theme</span>
                </button>
              </div>
              <p id="themeStatus" class="field-status"></p>
            </section>
          </div>
        </div>
      </section>

      <div class="pane-menu" id="paneMenu" hidden role="menu" aria-label="Pane menu" data-i18n-aria="menu.pane">
        <button type="button" data-pane-action="split-up" role="menuitem">
          <i data-lucide="panel-top"></i>
          <span data-i18n="action.splitUp">Split up</span>
        </button>
        <button type="button" data-pane-action="split-down" role="menuitem">
          <i data-lucide="panel-bottom"></i>
          <span data-i18n="action.splitDown">Split down</span>
        </button>
        <button type="button" data-pane-action="split-left" role="menuitem">
          <i data-lucide="panel-left"></i>
          <span data-i18n="action.splitLeft">Split left</span>
        </button>
        <button type="button" data-pane-action="split-right" role="menuitem">
          <i data-lucide="panel-right"></i>
          <span data-i18n="action.splitRight">Split right</span>
        </button>
        <button type="button" data-pane-action="copy-selection" role="menuitem">
          <i data-lucide="copy"></i>
          <span data-i18n="action.copySelection">Copy selection</span>
        </button>
        <button type="button" data-pane-action="paste-clipboard" role="menuitem">
          <i data-lucide="clipboard-paste"></i>
          <span data-i18n="action.pasteClipboard">Paste</span>
        </button>
        <button type="button" data-pane-action="promote-session-to-tab" role="menuitem" hidden>
          <i data-lucide="external-link"></i>
          <span data-i18n="action.promoteSessionToTab">Move session to new tab</span>
        </button>
        <button type="button" data-pane-action="close-active-session" data-tone="danger" role="menuitem">
          <i data-lucide="square-x"></i>
          <span data-i18n="action.closeActiveSession">Close active session</span>
        </button>
      </div>
    </main>
  `;

  return {
    webshell: qs<HTMLElement>("#webshell"),
    topbar: qs<HTMLElement>(".topbar"),
    instanceList: qs<HTMLDivElement>("#instanceList"),
    instanceSwitcher: qs<HTMLDivElement>("#instanceSwitcher"),
    instanceButton: qs<HTMLButtonElement>("#instanceButton"),
    instanceMenu: qs<HTMLDivElement>("#instanceMenu"),
    instanceStatusDot: qs<HTMLSpanElement>("#instanceStatusDot"),
    refreshInstances: qs<HTMLButtonElement>("#refreshInstances"),
    newTabButton: qs<HTMLButtonElement>("#newTabButton"),
    emptyNewTab: qs<HTMLButtonElement>("#emptyNewTab"),
    statusLine: qs<HTMLParagraphElement>("#statusLine"),
    targetLabel: qs<HTMLElement>("#targetLabel"),
    tabList: qs<HTMLDivElement>("#tabList"),
    terminalStage: qs<HTMLDivElement>("#terminalStage"),
    mobileShortcuts: qs<HTMLDivElement>("#mobileShortcuts"),
    emptyState: qs<HTMLDivElement>("#emptyState"),
    homeButton: qs<HTMLButtonElement>("#homeButton"),
    settingsButton: qs<HTMLButtonElement>("#settingsButton"),
    settingsMenu: qs<HTMLDivElement>("#settingsMenu"),
    openSettingsItem: qs<HTMLButtonElement>("#openSettingsItem"),
    closeSettings: qs<HTMLButtonElement>("#closeSettings"),
    settingsPage: qs<HTMLElement>("#settingsPage"),
    settingsTabs: qs<HTMLDivElement>("#settingsTabs"),
    fontTabs: qs<HTMLDivElement>("#fontTabs"),
    localeSelect: qs<HTMLSelectElement>("#localeSelect"),
    themeSelect: qs<HTMLSelectElement>("#themeSelect"),
    customThemeName: qs<HTMLInputElement>("#customThemeName"),
    customThemeSource: qs<HTMLTextAreaElement>("#customThemeSource"),
    saveTheme: qs<HTMLButtonElement>("#saveTheme"),
    removeTheme: qs<HTMLButtonElement>("#removeTheme"),
    themeStatus: qs<HTMLElement>("#themeStatus"),
    fontFamily: qs<HTMLSelectElement>("#fontFamily"),
    fontPreview: qs<HTMLDivElement>("#fontPreview"),
    tabLayout: qs<HTMLSelectElement>("#tabLayout"),
    fontUpload: qs<HTMLInputElement>("#fontUpload"),
    removeFont: qs<HTMLButtonElement>("#removeFont"),
    fontStatus: qs<HTMLElement>("#fontStatus"),
    fontSize: qs<HTMLInputElement>("#fontSize"),
    fontSizeValue: qs<HTMLOutputElement>("#fontSizeValue"),
    lineHeight: qs<HTMLInputElement>("#lineHeight"),
    lineHeightValue: qs<HTMLOutputElement>("#lineHeightValue"),
    scrollbackLimit: qs<HTMLInputElement>("#scrollbackLimit"),
    outputBufferLimit: qs<HTMLInputElement>("#outputBufferLimit"),
    cursorBlink: qs<HTMLInputElement>("#cursorBlink"),
    cursorShape: qs<HTMLSelectElement>("#cursorShape"),
    copyOnSelect: qs<HTMLInputElement>("#copyOnSelect"),
    useResttyClipboard: qs<HTMLInputElement>("#useResttyClipboard"),
    touchSelectionMode: qs<HTMLSelectElement>("#touchSelectionMode"),
    autoRestartSessions: qs<HTMLInputElement>("#autoRestartSessions"),
    debugMode: qs<HTMLInputElement>("#debugMode"),
    paneMenu: qs<HTMLDivElement>("#paneMenu"),
    fitTerminal: qs<HTMLButtonElement>("#fitTerminal"),
  };
}
