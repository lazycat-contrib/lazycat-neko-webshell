import { qs } from "./utils";
import { renderAboutDialog } from "./about-view";
import { renderMobileKeyboardView } from "./mobile/keyboard-view";
import { renderMobileSettingsView } from "./mobile/settings-view";
import { renderTerminalControlSettingsView } from "./terminal-control/settings-view";

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
  newTabShell: HTMLDivElement;
  newTabMenu: HTMLDivElement;
  emptyNewTab: HTMLButtonElement;
  statusLine: HTMLParagraphElement;
  targetLabel: HTMLElement;
  tabList: HTMLDivElement;
  herdrWorkspaceSwitcher: HTMLDivElement;
  herdrWorkspaceButton: HTMLButtonElement;
  herdrWorkspaceMenu: HTMLDivElement;
  herdrWorkspaceRefresh: HTMLButtonElement;
  herdrWorkspaceMenuList: HTMLDivElement;
  herdrWorkspaceMenuStatus: HTMLParagraphElement;
  herdrDock: HTMLElement;
  herdrWorkspaceList: HTMLDivElement;
  herdrTabList: HTMLDivElement;
  herdrStatus: HTMLParagraphElement;
  herdrProtocolNotice: HTMLSpanElement;
  herdrRefresh: HTMLButtonElement;
  herdrNewWorkspace: HTMLButtonElement;
  herdrNewTab: HTMLButtonElement;
  terminalStage: HTMLDivElement;
  mobileShortcuts: HTMLDivElement;
  terminalInputActionsSurface: HTMLDivElement;
  mobileShortcutClock: HTMLSpanElement;
  emptyState: HTMLDivElement;
  homeButton: HTMLButtonElement;
  settingsButton: HTMLButtonElement;
  settingsMenu: HTMLDivElement;
  openAboutItem: HTMLButtonElement;
  openSettingsItem: HTMLButtonElement;
  openPluginsItem: HTMLButtonElement;
  openShortcutHelpItem: HTMLButtonElement;
  fitTerminalItem: HTMLButtonElement;
  notificationsShell: HTMLDivElement;
  notificationsButton: HTMLButtonElement;
  notificationCount: HTMLSpanElement;
  notificationsMenu: HTMLDivElement;
  notificationList: HTMLDivElement;
  notificationModal: HTMLDivElement;
  notificationModalBody: HTMLDivElement;
  pluginsButton: HTMLButtonElement;
  pluginSidebar: HTMLElement;
  closePluginSidebar: HTMLButtonElement;
  pluginToolTabs: HTMLDivElement;
  pluginToolBody: HTMLDivElement;
  pluginToolStatus: HTMLElement;
  whiteNoiseFloatingControls: HTMLDivElement;
  closeSettings: HTMLButtonElement;
  settingsPage: HTMLElement;
  settingsTabs: HTMLDivElement;
  fontTabs: HTMLDivElement;
  pluginList: HTMLDivElement;
  pluginStatus: HTMLElement;
  refreshPlugins: HTMLButtonElement;
  localeSelect: HTMLSelectElement;
  interfaceStyleSelect: HTMLSelectElement;
  sessionBackendSettings: HTMLDivElement;
  defaultSessionBackend: HTMLSelectElement;
  sessionBackendHelp: HTMLParagraphElement;
  sshProfileSettings: HTMLDivElement;
  herdrHighlightSettings: HTMLDivElement;
  herdrActiveBackgroundDark: HTMLInputElement;
  herdrActiveBackgroundLight: HTMLInputElement;
  themeSelect: HTMLSelectElement;
  customThemeName: HTMLInputElement;
  customThemeSource: HTMLTextAreaElement;
  saveTheme: HTMLButtonElement;
  removeTheme: HTMLButtonElement;
  themeStatus: HTMLElement;
  fontFamily: HTMLSelectElement;
  fontPreview: HTMLDivElement;
  fontRenderingSettings: HTMLDivElement;
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
  terminalControlSettings: HTMLDivElement;
  terminalSingleControllerMode: HTMLInputElement;
  terminalBlurObservers: HTMLInputElement;
  terminalBackgroundEnabled: HTMLInputElement;
  terminalBackgroundUpload: HTMLInputElement;
  removeTerminalBackground: HTMLButtonElement;
  terminalBackgroundOpacity: HTMLInputElement;
  terminalBackgroundOpacityValue: HTMLOutputElement;
  terminalBackgroundBlur: HTMLInputElement;
  terminalBackgroundBlurValue: HTMLOutputElement;
  terminalBackgroundStatus: HTMLElement;
  terminalShaderSettings: HTMLDivElement;
  cursorBlink: HTMLInputElement;
  cursorShape: HTMLSelectElement;
  copyOnSelect: HTMLInputElement;
  useResttyClipboard: HTMLInputElement;
  touchSelectionMode: HTMLSelectElement;
  mobileClockEnabled: HTMLInputElement;
  mobileClockUse24Hour: HTMLInputElement;
  mobileClockShowPeriod: HTMLInputElement;
  mobileQuickPhraseSettings: HTMLDivElement;
  mobileQuickPhraseList: HTMLDivElement;
  mobileQuickPhraseLabel: HTMLInputElement;
  mobileQuickPhraseText: HTMLTextAreaElement;
  mobileQuickPhraseSave: HTMLButtonElement;
  mobileQuickPhraseCancel: HTMLButtonElement;
  mobileQuickPhraseStatus: HTMLElement;
  autoRestartSessions: HTMLInputElement;
  debugMode: HTMLInputElement;
  shortcutHelpButton: HTMLButtonElement;
  shortcutHelp: HTMLDivElement;
  shortcutHelpClose: HTMLButtonElement;
  aboutDialog: HTMLDivElement;
  aboutClose: HTMLButtonElement;
  paneMenu: HTMLDivElement;
  terminalControlOverlay: HTMLDivElement;
  fitTerminal: HTMLButtonElement;
};

export function renderShell(app: HTMLElement): ShellElements {
  app.innerHTML = `
    <main class="webshell" id="webshell" aria-label="Neko Webshell workspace" data-i18n-aria="app.title">
      <header class="topbar" aria-label="Terminal controls" data-i18n-aria="app.title">
        <div class="tabs-shell">
          <div id="tabList" class="tab-list" role="tablist" aria-label="Terminal tabs" data-i18n-aria="action.newTab"></div>
          <div class="new-tab-shell" id="newTabShell">
            <button class="tab-add" id="newTabButton" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="New terminal tab" title="New terminal tab" data-i18n-aria="action.newTab" data-i18n-title="action.newTab">
              <i data-lucide="plus"></i>
            </button>
            <div class="new-tab-menu" id="newTabMenu" role="menu" aria-label="New terminal tab" data-i18n-aria="action.newTab" hidden></div>
          </div>
        </div>
        <div class="topbar-actions">
          <div class="herdr-workspace-switcher" id="herdrWorkspaceSwitcher" hidden>
            <button class="icon-button" id="herdrWorkspaceButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Herdr workspaces" title="Herdr workspaces" data-i18n-aria="section.herdrWorkspaces" data-i18n-title="section.herdrWorkspaces">
              <i data-lucide="folder-tree"></i>
            </button>
            <div class="herdr-workspace-menu" id="herdrWorkspaceMenu" role="dialog" aria-label="Herdr workspaces" data-i18n-aria="section.herdrWorkspaces" hidden>
              <div class="menu-head">
                <span data-i18n="section.herdrWorkspaces">Herdr workspaces</span>
                <button class="icon-button" id="herdrWorkspaceRefresh" type="button" aria-label="Refresh Herdr" title="Refresh Herdr" data-i18n-aria="action.refreshHerdr" data-i18n-title="action.refreshHerdr">
                  <i data-lucide="refresh-cw"></i>
                </button>
              </div>
              <div class="herdr-workspace-menu-list" id="herdrWorkspaceMenuList" role="listbox" aria-label="Herdr workspaces" data-i18n-aria="section.herdrWorkspaces"></div>
              <p class="herdr-workspace-menu-status" id="herdrWorkspaceMenuStatus" aria-live="polite"></p>
            </div>
          </div>
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
          <div class="shortcut-help-shell" id="shortcutHelpShell">
            <button class="icon-button" id="shortcutHelpButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Keyboard shortcuts" title="Keyboard shortcuts" data-i18n-aria="action.shortcutHelp" data-i18n-title="action.shortcutHelp">
              <i data-lucide="circle-help"></i>
            </button>
            <div class="shortcut-help" id="shortcutHelp" hidden>
              <div class="shortcut-help-dialog" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" data-i18n-aria="action.shortcutHelp">
                <div class="shortcut-help-head">
                  <strong data-i18n="section.shortcuts">Shortcuts</strong>
                  <button class="icon-button" id="shortcutHelpClose" type="button" aria-label="Close settings" title="Close settings" data-i18n-aria="action.closeSettings" data-i18n-title="action.closeSettings">
                    <i data-lucide="x"></i>
                  </button>
                </div>
                <div class="shortcut-help-grid">
                  <section>
                    <h3 data-i18n="section.desktopShortcuts">Desktop</h3>
                    <dl>
                      <div><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>T</kbd></dt><dd data-i18n="shortcut.newTab">New terminal tab</dd></div>
                      <div><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>W</kbd></dt><dd data-i18n="shortcut.closeTab">Close tab</dd></div>
                      <div><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>↑/↓/←/→</kbd></dt><dd data-i18n="shortcut.splitPane">Split pane</dd></div>
                      <div><dt><kbd>Ctrl</kbd><kbd>+</kbd> / <kbd>Ctrl</kbd><kbd>-</kbd></dt><dd data-i18n="shortcut.zoomFont">Adjust terminal font</dd></div>
                      <div><dt><kbd>Ctrl</kbd><kbd>0</kbd></dt><dd data-i18n="shortcut.resetFont">Reset terminal font</dd></div>
                      <div><dt><kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>C/V</kbd></dt><dd data-i18n="shortcut.copyPaste">Copy or paste</dd></div>
                    </dl>
                  </section>
                  <section>
                    <h3 data-i18n="section.mobileShortcuts">Mobile</h3>
                    <dl>
                      <div><dt><kbd>Ops</kbd><kbd>A+</kbd>/<kbd>A-</kbd></dt><dd data-i18n="shortcut.mobileFont">Adjust terminal font</dd></div>
                      <div><dt><kbd>Ops</kbd><kbd>Tab</kbd></dt><dd data-i18n="shortcut.mobileTab">Switch or create tabs</dd></div>
                      <div><dt><kbd>Main</kbd><kbd>Ctrl</kbd><kbd>Tab</kbd></dt><dd data-i18n="shortcut.mobileKeys">Send terminal keys</dd></div>
                      <div><dt><kbd>double tap</kbd></dt><dd data-i18n="shortcut.mobileKeyboard">Open system keyboard</dd></div>
                    </dl>
                  </section>
                </div>
              </div>
            </div>
          </div>
          <div class="notifications-shell" id="notificationsShell" hidden>
            <button class="icon-button notification-button" id="notificationsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Notifications" title="Notifications" data-i18n-aria="section.notifications" data-i18n-title="section.notifications">
              <i data-lucide="bell"></i>
              <span class="notification-count" id="notificationCount" hidden></span>
            </button>
            <div class="notifications-menu" id="notificationsMenu" role="dialog" aria-label="Notifications" data-i18n-aria="section.notifications" hidden>
              <div class="menu-head">
                <span data-i18n="section.notifications">Notifications</span>
              </div>
              <div class="notification-list" id="notificationList" role="list" aria-live="polite"></div>
            </div>
          </div>
          <button class="icon-button" id="pluginsButton" type="button" aria-haspopup="dialog" aria-expanded="false" aria-label="Tools" title="Tools" data-i18n-aria="section.plugins" data-i18n-title="section.plugins">
            <i data-lucide="plug"></i>
          </button>
          <div class="settings-menu-shell" id="settingsMenuShell">
            <button class="icon-button" id="settingsButton" type="button" aria-haspopup="menu" aria-expanded="false" aria-label="Settings menu" title="Settings menu" data-i18n-aria="action.settingsMenu" data-i18n-title="action.settingsMenu">
              <i data-lucide="menu"></i>
            </button>
            <div class="settings-menu" id="settingsMenu" role="menu" aria-label="Settings menu" data-i18n-aria="action.settingsMenu" hidden>
              <button id="openPluginsItem" type="button" role="menuitem">
                <i data-lucide="plug"></i>
                <span data-i18n="section.plugins">Tools</span>
              </button>
              <button id="openShortcutHelpItem" type="button" role="menuitem">
                <i data-lucide="circle-help"></i>
                <span data-i18n="action.shortcutHelp">Keyboard shortcuts</span>
              </button>
              <button id="openAboutItem" type="button" role="menuitem">
                <i data-lucide="info"></i>
                <span data-i18n="action.about">About</span>
              </button>
              <button id="fitTerminalItem" type="button" role="menuitem">
                <i data-lucide="maximize"></i>
                <span data-i18n="action.fullscreen">Full screen</span>
              </button>
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

      ${renderAboutDialog()}

      <section class="herdr-dock" id="herdrDock" aria-label="Herdr controls" data-i18n-aria="section.herdr" hidden>
        <div class="herdr-workspaces" id="herdrWorkspaceList" role="listbox" aria-label="Herdr workspaces" data-i18n-aria="section.herdrWorkspaces"></div>
        <div class="herdr-tabs-shell">
          <div class="herdr-tabs" id="herdrTabList" role="tablist" aria-label="Herdr tabs" data-i18n-aria="section.herdrTabs"></div>
          <button class="herdr-icon-button" id="herdrNewWorkspace" type="button" aria-label="New Herdr space" title="New Herdr space" data-i18n-aria="action.newHerdrSpace" data-i18n-title="action.newHerdrSpace">
            <i data-lucide="folder-plus"></i>
          </button>
          <button class="herdr-icon-button" id="herdrNewTab" type="button" aria-label="New Herdr tab" title="New Herdr tab" data-i18n-aria="action.newHerdrTab" data-i18n-title="action.newHerdrTab">
            <i data-lucide="plus"></i>
          </button>
          <span class="herdr-protocol-notice" id="herdrProtocolNotice" role="img" hidden>
            <i data-lucide="arrow-up"></i>
          </span>
          <button class="herdr-icon-button" id="herdrRefresh" type="button" aria-label="Refresh Herdr" title="Refresh Herdr" data-i18n-aria="action.refreshHerdr" data-i18n-title="action.refreshHerdr">
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
        <p class="herdr-status" id="herdrStatus" aria-live="polite"></p>
      </section>

      <section id="terminalStage" class="terminal-stage" aria-label="Terminal" data-i18n-aria="app.title">
        <div class="empty-state" id="emptyState">
          <button class="command-button primary icon-only-large" id="emptyNewTab" type="button" aria-label="New terminal tab" title="New terminal tab" data-i18n-aria="action.newTab" data-i18n-title="action.newTab">
            <i data-lucide="square-plus"></i>
          </button>
          <p id="statusLine" aria-live="polite" data-i18n="status.idle">Idle</p>
        </div>
        <div id="terminalControlOverlay" class="terminal-control-overlay" hidden></div>
      </section>

      <div class="notification-modal" id="notificationModal" hidden>
        <div class="notification-modal-dialog" role="dialog" aria-modal="true" aria-label="Notification" data-i18n-aria="section.notifications">
          <div id="notificationModalBody"></div>
        </div>
      </div>

      ${renderMobileKeyboardView()}

      <div class="terminal-input-actions-surface" id="terminalInputActionsSurface" hidden></div>

      <aside class="plugin-sidebar" id="pluginSidebar" aria-label="Tools" data-i18n-aria="section.plugins" hidden>
        <header class="plugin-sidebar-header">
          <strong data-i18n="section.plugins">Tools</strong>
          <button class="icon-button" id="closePluginSidebar" type="button" aria-label="Close tools" title="Close tools" data-i18n-aria="action.closePlugins" data-i18n-title="action.closePlugins">
            <i data-lucide="x"></i>
          </button>
        </header>
        <div class="plugin-tool-tabs" id="pluginToolTabs" role="tablist" aria-label="Tools" data-i18n-aria="section.plugins"></div>
        <div class="plugin-tool-body" id="pluginToolBody"></div>
        <p id="pluginToolStatus" class="field-status"></p>
      </aside>

      <div id="whiteNoiseFloatingControls" hidden></div>

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
            <button type="button" role="tab" aria-selected="false" aria-controls="terminalSettingsPanel" data-settings-tab="terminal">
              <i data-lucide="terminal"></i>
              <span data-i18n="tab.terminal">Terminal</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="remoteHostsSettingsPanel" data-settings-tab="remote-hosts">
              <i data-lucide="server-cog"></i>
              <span data-i18n="tab.remoteHosts">Remote hosts</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="fontSettingsRootPanel" data-settings-tab="fonts">
              <i data-lucide="type"></i>
              <span data-i18n="tab.fonts">Fonts</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="themeSettingsPanel" data-settings-tab="themes">
              <i data-lucide="palette"></i>
              <span data-i18n="tab.themes">Themes</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="mobileSettingsPanel" data-settings-tab="mobile">
              <i data-lucide="smartphone"></i>
              <span data-i18n="tab.mobile">Mobile</span>
            </button>
            <button type="button" role="tab" aria-selected="false" aria-controls="pluginSettingsPanel" data-settings-tab="plugins">
              <i data-lucide="plug"></i>
              <span data-i18n="tab.plugins">Tools</span>
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
                <span data-i18n="field.interfaceStyle">Interface style</span>
                <select id="interfaceStyleSelect">
                  <option value="steel" data-i18n="interfaceStyle.steel">Steel</option>
                  <option value="glass" data-i18n="interfaceStyle.glass">Glass</option>
                  <option value="brass" data-i18n="interfaceStyle.brass">Brass</option>
                  <option value="spectrum" data-i18n="interfaceStyle.spectrum">Spectrum</option>
                  <option value="geek" data-i18n="interfaceStyle.geek">Geek</option>
                  <option value="porcelain" data-i18n="interfaceStyle.porcelain">Porcelain</option>
                  <option value="frost" data-i18n="interfaceStyle.frost">Frost</option>
                  <option value="champagne" data-i18n="interfaceStyle.champagne">Champagne</option>
                  <option value="candy" data-i18n="interfaceStyle.candy">Candy</option>
                  <option value="lab" data-i18n="interfaceStyle.lab">Lab</option>
                </select>
              </label>
              <label class="field">
                <span data-i18n="field.tabs">Tabs</span>
                <select id="tabLayout">
                  <option value="horizontal" data-i18n="layout.horizontal">Horizontal</option>
                  <option value="vertical" data-i18n="layout.vertical">Vertical</option>
                </select>
              </label>
              <div class="settings-group" id="herdrHighlightSettings" hidden>
                <div class="settings-group-title" data-i18n="section.herdrHighlight">Herdr selection</div>
                <p class="settings-help" data-i18n="setting.herdrHighlightHelp">Customize the active Herdr workspace and tab background for dark and light interface styles.</p>
                <label class="field color-field">
                  <span data-i18n="field.herdrActiveBackgroundDark">Dark highlight</span>
                  <input id="herdrActiveBackgroundDark" type="color" />
                </label>
                <label class="field color-field">
                  <span data-i18n="field.herdrActiveBackgroundLight">Light highlight</span>
                  <input id="herdrActiveBackgroundLight" type="color" />
                </label>
              </div>
            </section>

            <section class="settings-section" id="terminalSettingsPanel" data-settings-panel="terminal" role="tabpanel" hidden>
              <div class="settings-group" id="sessionBackendSettings" hidden>
                <div class="settings-group-title" data-i18n="section.sessionBackend">Session backend</div>
                <label class="field">
                  <span data-i18n="field.defaultSessionBackend">New tab backend</span>
                  <select id="defaultSessionBackend">
                    <option value="webshell" data-i18n="backend.webshell">WebShell native</option>
                  </select>
                </label>
                <p id="sessionBackendHelp" class="settings-help" data-i18n="setting.defaultSessionBackendHelp">The + button uses this backend. If Herdr already has an engine pane, + creates a new Herdr workspace inside that session.</p>
              </div>
              <label class="field">
                <span data-i18n="field.cursor">Cursor</span>
                <select id="cursorShape">
                  <option value="block" data-i18n="cursor.block">Block</option>
                  <option value="bar" data-i18n="cursor.bar">Bar</option>
                  <option value="underline" data-i18n="cursor.underline">Underline</option>
                </select>
              </label>
              <div id="terminalShaderSettings" class="terminal-shader-settings"></div>
              <label class="field">
                <span data-i18n="field.scrollback">Scrollback</span>
                <input id="scrollbackLimit" type="number" min="1000" max="100000" step="1000" />
              </label>
              <label class="field">
                <span data-i18n="field.outputBuffer">Output buffer</span>
                <input id="outputBufferLimit" type="number" min="128" max="20000" step="128" />
              </label>
              <div id="terminalControlSettings">${renderTerminalControlSettingsView()}</div>
              <div class="settings-group terminal-background-settings">
                <div class="settings-group-title" data-i18n="section.terminalBackground">Terminal background</div>
                <label class="switch">
                  <input id="terminalBackgroundEnabled" type="checkbox" />
                  <span data-i18n="setting.terminalBackground">Use background image</span>
                </label>
                <div class="background-actions">
                  <label class="file-button" aria-label="Upload terminal background" title="Upload terminal background" data-i18n-aria="action.uploadTerminalBackground" data-i18n-title="action.uploadTerminalBackground">
                    <input id="terminalBackgroundUpload" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" />
                    <i data-lucide="image-plus"></i>
                    <span data-i18n="action.uploadTerminalBackground">Upload terminal background</span>
                  </label>
                  <button class="command-button" id="removeTerminalBackground" type="button" aria-label="Remove terminal background" title="Remove terminal background" data-i18n-aria="action.removeTerminalBackground" data-i18n-title="action.removeTerminalBackground">
                    <i data-lucide="trash-2"></i>
                    <span data-i18n="action.removeTerminalBackground">Remove terminal background</span>
                  </button>
                </div>
                <label class="field">
                  <span><span data-i18n="field.terminalBackgroundOpacity">Background opacity</span> <output id="terminalBackgroundOpacityValue"></output></span>
                  <input id="terminalBackgroundOpacity" type="range" min="0.05" max="0.8" step="0.01" />
                </label>
                <label class="field">
                  <span><span data-i18n="field.terminalBackgroundBlur">Background blur</span> <output id="terminalBackgroundBlurValue"></output></span>
                  <input id="terminalBackgroundBlur" type="range" min="0" max="24" step="1" />
                </label>
                <p id="terminalBackgroundStatus" class="field-status"></p>
              </div>
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
              <label class="switch">
                <input id="autoRestartSessions" type="checkbox" />
                <span data-i18n="setting.autoRestartSessions">Restart sessions after provider restart</span>
              </label>
              <label class="switch">
                <input id="debugMode" type="checkbox" />
                <span data-i18n="setting.debugAdapter">Debug adapter</span>
              </label>
            </section>

            <section class="settings-section" id="remoteHostsSettingsPanel" data-settings-panel="remote-hosts" role="tabpanel" hidden>
              <div class="settings-group ssh-profile-settings" id="sshProfileSettings"></div>
            </section>

            ${renderMobileSettingsView()}

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
                  <span data-i18n="app.title">Neko Webshell</span>
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
                <div id="fontRenderingSettings"></div>
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
                <span data-i18n="field.theme">Terminal theme</span>
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

            <section class="settings-section" id="pluginSettingsPanel" data-settings-panel="plugins" role="tabpanel" hidden>
              <div class="settings-section-head">
                <div class="settings-group-title" data-i18n="section.plugins">Tools</div>
                <button class="icon-button" id="refreshPlugins" type="button" aria-label="Refresh tools" title="Refresh tools" data-i18n-aria="action.refreshPlugins" data-i18n-title="action.refreshPlugins">
                  <i data-lucide="refresh-cw"></i>
                </button>
              </div>
              <div class="plugin-list" id="pluginList" role="list" aria-live="polite"></div>
              <p id="pluginStatus" class="field-status"></p>
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
        <button type="button" data-pane-action="resize-up" role="menuitem" hidden>
          <i data-lucide="arrow-up"></i>
          <span data-i18n="action.resizeUp">Resize up</span>
        </button>
        <button type="button" data-pane-action="resize-down" role="menuitem" hidden>
          <i data-lucide="arrow-down"></i>
          <span data-i18n="action.resizeDown">Resize down</span>
        </button>
        <button type="button" data-pane-action="resize-left" role="menuitem" hidden>
          <i data-lucide="arrow-left"></i>
          <span data-i18n="action.resizeLeft">Resize left</span>
        </button>
        <button type="button" data-pane-action="resize-right" role="menuitem" hidden>
          <i data-lucide="arrow-right"></i>
          <span data-i18n="action.resizeRight">Resize right</span>
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
    newTabShell: qs<HTMLDivElement>("#newTabShell"),
    newTabMenu: qs<HTMLDivElement>("#newTabMenu"),
    emptyNewTab: qs<HTMLButtonElement>("#emptyNewTab"),
    statusLine: qs<HTMLParagraphElement>("#statusLine"),
    targetLabel: qs<HTMLElement>("#targetLabel"),
    tabList: qs<HTMLDivElement>("#tabList"),
    herdrWorkspaceSwitcher: qs<HTMLDivElement>("#herdrWorkspaceSwitcher"),
    herdrWorkspaceButton: qs<HTMLButtonElement>("#herdrWorkspaceButton"),
    herdrWorkspaceMenu: qs<HTMLDivElement>("#herdrWorkspaceMenu"),
    herdrWorkspaceRefresh: qs<HTMLButtonElement>("#herdrWorkspaceRefresh"),
    herdrWorkspaceMenuList: qs<HTMLDivElement>("#herdrWorkspaceMenuList"),
    herdrWorkspaceMenuStatus: qs<HTMLParagraphElement>("#herdrWorkspaceMenuStatus"),
    herdrDock: qs<HTMLElement>("#herdrDock"),
    herdrWorkspaceList: qs<HTMLDivElement>("#herdrWorkspaceList"),
    herdrTabList: qs<HTMLDivElement>("#herdrTabList"),
    herdrStatus: qs<HTMLParagraphElement>("#herdrStatus"),
    herdrProtocolNotice: qs<HTMLSpanElement>("#herdrProtocolNotice"),
    herdrRefresh: qs<HTMLButtonElement>("#herdrRefresh"),
    herdrNewWorkspace: qs<HTMLButtonElement>("#herdrNewWorkspace"),
    herdrNewTab: qs<HTMLButtonElement>("#herdrNewTab"),
    terminalStage: qs<HTMLDivElement>("#terminalStage"),
    mobileShortcuts: qs<HTMLDivElement>("#mobileShortcuts"),
    terminalInputActionsSurface: qs<HTMLDivElement>("#terminalInputActionsSurface"),
    mobileShortcutClock: qs<HTMLSpanElement>("#mobileShortcutClock"),
    emptyState: qs<HTMLDivElement>("#emptyState"),
    homeButton: qs<HTMLButtonElement>("#homeButton"),
    settingsButton: qs<HTMLButtonElement>("#settingsButton"),
    settingsMenu: qs<HTMLDivElement>("#settingsMenu"),
    openAboutItem: qs<HTMLButtonElement>("#openAboutItem"),
    openSettingsItem: qs<HTMLButtonElement>("#openSettingsItem"),
    openPluginsItem: qs<HTMLButtonElement>("#openPluginsItem"),
    openShortcutHelpItem: qs<HTMLButtonElement>("#openShortcutHelpItem"),
    fitTerminalItem: qs<HTMLButtonElement>("#fitTerminalItem"),
    notificationsShell: qs<HTMLDivElement>("#notificationsShell"),
    notificationsButton: qs<HTMLButtonElement>("#notificationsButton"),
    notificationCount: qs<HTMLSpanElement>("#notificationCount"),
    notificationsMenu: qs<HTMLDivElement>("#notificationsMenu"),
    notificationList: qs<HTMLDivElement>("#notificationList"),
    notificationModal: qs<HTMLDivElement>("#notificationModal"),
    notificationModalBody: qs<HTMLDivElement>("#notificationModalBody"),
    pluginsButton: qs<HTMLButtonElement>("#pluginsButton"),
    pluginSidebar: qs<HTMLElement>("#pluginSidebar"),
    closePluginSidebar: qs<HTMLButtonElement>("#closePluginSidebar"),
    pluginToolTabs: qs<HTMLDivElement>("#pluginToolTabs"),
    pluginToolBody: qs<HTMLDivElement>("#pluginToolBody"),
    pluginToolStatus: qs<HTMLElement>("#pluginToolStatus"),
    whiteNoiseFloatingControls: qs<HTMLDivElement>("#whiteNoiseFloatingControls"),
    closeSettings: qs<HTMLButtonElement>("#closeSettings"),
    settingsPage: qs<HTMLElement>("#settingsPage"),
    settingsTabs: qs<HTMLDivElement>("#settingsTabs"),
    fontTabs: qs<HTMLDivElement>("#fontTabs"),
    pluginList: qs<HTMLDivElement>("#pluginList"),
    pluginStatus: qs<HTMLElement>("#pluginStatus"),
    refreshPlugins: qs<HTMLButtonElement>("#refreshPlugins"),
    localeSelect: qs<HTMLSelectElement>("#localeSelect"),
    interfaceStyleSelect: qs<HTMLSelectElement>("#interfaceStyleSelect"),
    sessionBackendSettings: qs<HTMLDivElement>("#sessionBackendSettings"),
    defaultSessionBackend: qs<HTMLSelectElement>("#defaultSessionBackend"),
    sessionBackendHelp: qs<HTMLParagraphElement>("#sessionBackendHelp"),
    sshProfileSettings: qs<HTMLDivElement>("#sshProfileSettings"),
    herdrHighlightSettings: qs<HTMLDivElement>("#herdrHighlightSettings"),
    herdrActiveBackgroundDark: qs<HTMLInputElement>("#herdrActiveBackgroundDark"),
    herdrActiveBackgroundLight: qs<HTMLInputElement>("#herdrActiveBackgroundLight"),
    themeSelect: qs<HTMLSelectElement>("#themeSelect"),
    customThemeName: qs<HTMLInputElement>("#customThemeName"),
    customThemeSource: qs<HTMLTextAreaElement>("#customThemeSource"),
    saveTheme: qs<HTMLButtonElement>("#saveTheme"),
    removeTheme: qs<HTMLButtonElement>("#removeTheme"),
    themeStatus: qs<HTMLElement>("#themeStatus"),
    fontFamily: qs<HTMLSelectElement>("#fontFamily"),
    fontPreview: qs<HTMLDivElement>("#fontPreview"),
    fontRenderingSettings: qs<HTMLDivElement>("#fontRenderingSettings"),
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
    terminalControlSettings: qs<HTMLDivElement>("#terminalControlSettings"),
    terminalSingleControllerMode: qs<HTMLInputElement>("#terminalSingleControllerMode"),
    terminalBlurObservers: qs<HTMLInputElement>("#terminalBlurObservers"),
    terminalBackgroundEnabled: qs<HTMLInputElement>("#terminalBackgroundEnabled"),
    terminalBackgroundUpload: qs<HTMLInputElement>("#terminalBackgroundUpload"),
    removeTerminalBackground: qs<HTMLButtonElement>("#removeTerminalBackground"),
    terminalBackgroundOpacity: qs<HTMLInputElement>("#terminalBackgroundOpacity"),
    terminalBackgroundOpacityValue: qs<HTMLOutputElement>("#terminalBackgroundOpacityValue"),
    terminalBackgroundBlur: qs<HTMLInputElement>("#terminalBackgroundBlur"),
    terminalBackgroundBlurValue: qs<HTMLOutputElement>("#terminalBackgroundBlurValue"),
    terminalBackgroundStatus: qs<HTMLElement>("#terminalBackgroundStatus"),
    terminalShaderSettings: qs<HTMLDivElement>("#terminalShaderSettings"),
    cursorBlink: qs<HTMLInputElement>("#cursorBlink"),
    cursorShape: qs<HTMLSelectElement>("#cursorShape"),
    copyOnSelect: qs<HTMLInputElement>("#copyOnSelect"),
    useResttyClipboard: qs<HTMLInputElement>("#useResttyClipboard"),
    touchSelectionMode: qs<HTMLSelectElement>("#touchSelectionMode"),
    mobileClockEnabled: qs<HTMLInputElement>("#mobileClockEnabled"),
    mobileClockUse24Hour: qs<HTMLInputElement>("#mobileClockUse24Hour"),
    mobileClockShowPeriod: qs<HTMLInputElement>("#mobileClockShowPeriod"),
    mobileQuickPhraseSettings: qs<HTMLDivElement>("#mobileQuickPhraseSettings"),
    mobileQuickPhraseList: qs<HTMLDivElement>("#mobileQuickPhraseList"),
    mobileQuickPhraseLabel: qs<HTMLInputElement>("#mobileQuickPhraseLabel"),
    mobileQuickPhraseText: qs<HTMLTextAreaElement>("#mobileQuickPhraseText"),
    mobileQuickPhraseSave: qs<HTMLButtonElement>("#mobileQuickPhraseSave"),
    mobileQuickPhraseCancel: qs<HTMLButtonElement>("#mobileQuickPhraseCancel"),
    mobileQuickPhraseStatus: qs<HTMLElement>("#mobileQuickPhraseStatus"),
    autoRestartSessions: qs<HTMLInputElement>("#autoRestartSessions"),
    debugMode: qs<HTMLInputElement>("#debugMode"),
    shortcutHelpButton: qs<HTMLButtonElement>("#shortcutHelpButton"),
    shortcutHelp: qs<HTMLDivElement>("#shortcutHelp"),
    shortcutHelpClose: qs<HTMLButtonElement>("#shortcutHelpClose"),
    aboutDialog: qs<HTMLDivElement>("#aboutDialog"),
    aboutClose: qs<HTMLButtonElement>("#aboutClose"),
    paneMenu: qs<HTMLDivElement>("#paneMenu"),
    terminalControlOverlay: qs<HTMLDivElement>("#terminalControlOverlay"),
    fitTerminal: qs<HTMLButtonElement>("#fitTerminal"),
  };
}
