import type { ShellElements } from "./shell";

type SettingsTabElements = Pick<ShellElements, "fontTabs" | "settingsPage" | "settingsTabs">;

export function bindSettingsTabControls(
  elements: SettingsTabElements,
  callbacks: {
    onFontTab: (tabId: string) => void;
    onSettingsTab: (tabId: string) => void;
  },
) {
  elements.settingsTabs.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-settings-tab]")
      : null;
    if (button) callbacks.onSettingsTab(button.dataset.settingsTab ?? "");
  });
  elements.fontTabs.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-font-tab]")
      : null;
    if (button) callbacks.onFontTab(button.dataset.fontTab ?? "");
  });
}

export function activateSettingsPanel(elements: SettingsTabElements, tabId: string): boolean {
  if (!tabId) return false;
  elements.settingsTabs.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === tabId;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.settingsPage.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tabId;
  });
  return true;
}

export function activateFontPanel(elements: SettingsTabElements, tabId: string): boolean {
  if (!tabId) return false;
  elements.fontTabs.querySelectorAll<HTMLButtonElement>("[data-font-tab]").forEach((button) => {
    const active = button.dataset.fontTab === tabId;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.settingsPage.querySelectorAll<HTMLElement>("[data-font-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.fontPanel !== tabId;
  });
  return true;
}
