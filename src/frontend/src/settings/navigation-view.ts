import type { MessageKey } from "../i18n";

const sections = [
  { id: "appearance", panel: "appearanceSettingsPanel", icon: "monitor-cog", label: "tab.appearance" },
  { id: "terminal", panel: "terminalSettingsPanel", icon: "terminal", label: "tab.terminal" },
  { id: "remote-hosts", panel: "remoteHostsSettingsPanel", icon: "server-cog", label: "tab.remoteHosts" },
  { id: "fonts", panel: "fontSettingsRootPanel", icon: "type", label: "tab.fonts" },
  { id: "themes", panel: "themeSettingsPanel", icon: "palette", label: "tab.themes" },
  { id: "mobile", panel: "mobileSettingsPanel", icon: "smartphone", label: "tab.mobile" },
  { id: "plugins", panel: "pluginSettingsPanel", icon: "plug", label: "tab.plugins" },
] as const satisfies readonly { id: string; panel: string; icon: string; label: MessageKey }[];

export function renderSettingsNavigation(): string {
  return `<div class="settings-tabs settings-main-tabs" id="settingsTabs" role="tablist" aria-orientation="vertical" aria-label="Settings" data-i18n-aria="action.settings">
    ${sections.map((section, index) => `<button type="button" id="settings-tab-${section.id}" role="tab"
      aria-selected="${index === 0}" aria-controls="${section.panel}" tabindex="${index === 0 ? 0 : -1}" data-settings-tab="${section.id}">
      <i data-lucide="${section.icon}" aria-hidden="true"></i><span data-i18n="${section.label}">${section.id}</span>
    </button>`).join("")}
  </div>`;
}

export function renderSettingsSectionIntro(id: string): string {
  const section = sections.find((item) => item.id === id);
  if (!section) return "";
  return `<header class="settings-panel-intro">
    <h3 data-i18n="${section.label}">${section.id}</h3>
    <p data-i18n="settings.description.${section.id}"></p>
  </header>`;
}
