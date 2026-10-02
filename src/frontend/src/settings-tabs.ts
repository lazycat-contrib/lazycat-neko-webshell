import type { ShellElements } from "./shell";

type SettingsTabElements = Pick<ShellElements, "fontTabs" | "settingsPage" | "settingsTabs">;

export function bindTabListKeyboard(container: HTMLElement, selector: string) {
  container.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || !(event.target instanceof Element)) return;
    const current = event.target.closest<HTMLButtonElement>(selector);
    if (!current || !container.contains(current)) return;
    const list = current.closest<HTMLElement>('[role="tablist"]') ?? container;
    const vertical = list.getAttribute("aria-orientation") === "vertical";
    const previous = vertical ? "ArrowUp" : "ArrowLeft";
    const next = vertical ? "ArrowDown" : "ArrowRight";
    if (![previous, next, "Home", "End"].includes(event.key)) return;
    const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>(selector))
      .filter((button) => !button.disabled && button.getClientRects().length > 0);
    const index = buttons.indexOf(current);
    if (index < 0 || !buttons.length) return;
    const target = event.key === "Home" ? buttons[0]
      : event.key === "End" ? buttons.at(-1)!
      : buttons[(index + (event.key === previous ? -1 : 1) + buttons.length) % buttons.length];
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.click();
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : target;
    focused.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  });
}

export function bindSettingsTabControls(
  elements: SettingsTabElements,
  callbacks: {
    onFontTab: (tabId: string) => void;
    onSettingsTab: (tabId: string) => void;
  },
) {
  const compact = window.matchMedia("(max-width: 760px)");
  const updateOrientation = () => elements.settingsTabs.setAttribute("aria-orientation", compact.matches ? "horizontal" : "vertical");
  updateOrientation();
  compact.addEventListener("change", updateOrientation);
  bindTabListKeyboard(elements.settingsTabs, "[data-settings-tab]");
  bindTabListKeyboard(elements.fontTabs, "[data-font-tab]");
  const initialFontTab = elements.fontTabs.querySelector<HTMLButtonElement>('[data-font-tab][aria-selected="true"]');
  if (initialFontTab) activateFontPanel(elements, initialFontTab.dataset.fontTab ?? "");
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
  if (!Array.from(elements.settingsTabs.querySelectorAll<HTMLButtonElement>("[data-settings-tab]"))
    .some((button) => button.dataset.settingsTab === tabId)) return false;
  elements.settingsTabs.querySelectorAll<HTMLButtonElement>("[data-settings-tab]").forEach((button) => {
    const active = button.dataset.settingsTab === tabId;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  elements.settingsPage.querySelectorAll<HTMLElement>("[data-settings-panel]").forEach((panel) => {
    panel.hidden = panel.dataset.settingsPanel !== tabId;
  });
  const panels = elements.settingsPage.querySelector<HTMLElement>(".settings-panels");
  panels?.scrollTo({ top: 0, behavior: "instant" });
  return true;
}

export function activateFontPanel(elements: SettingsTabElements, tabId: string): boolean {
  if (!Array.from(elements.fontTabs.querySelectorAll<HTMLButtonElement>("[data-font-tab]"))
    .some((button) => button.dataset.fontTab === tabId)) return false;
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
