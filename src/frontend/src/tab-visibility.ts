export type InstanceTabDisplay = "combined" | "by-instance";

export function visibleInstanceTabs<T extends { selector: string }>(
  tabs: T[],
  selectedSelector: string,
  display: InstanceTabDisplay,
): T[] {
  return display === "by-instance"
    ? tabs.filter((tab) => tab.selector === selectedSelector)
    : tabs;
}
