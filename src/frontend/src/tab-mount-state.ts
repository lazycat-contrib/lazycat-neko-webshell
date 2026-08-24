export type TabMountStateItem = {
  id: string;
  mount: HTMLElement;
};

export function syncActiveTabMounts(tabs: TabMountStateItem[], activeTabId: string) {
  for (const tab of tabs) {
    const active = tab.id === activeTabId;
    tab.mount.classList.toggle("active", active);
    tab.mount.setAttribute("aria-hidden", active ? "false" : "true");
  }
}
