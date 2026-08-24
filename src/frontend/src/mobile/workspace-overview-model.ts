import type { SessionBackendId, TerminalPane, TerminalTab } from "../types.ts";
import type { MobileWorkspaceOverviewTab } from "./workspace-overview-types.ts";

type Options = {
  tabs: TerminalTab[];
  activeTabId: string | undefined;
  tabLabel: (tab: TerminalTab) => string;
  selectorLabel: (selector: string) => string;
  visiblePanes: (tab: TerminalTab) => TerminalPane[];
  backendLabel: (backend: SessionBackendId) => string;
};

export function buildMobileWorkspaceOverviewItems(options: Options): MobileWorkspaceOverviewTab[] {
  return options.tabs.filter((tab) => !tab.closing).map((tab) => ({
    id: tab.id,
    label: options.tabLabel(tab),
    detail: options.selectorLabel(tab.selector),
    active: tab.id === options.activeTabId,
    panes: options.visiblePanes(tab).map((pane) => ({
      id: pane.id,
      label: pane.title || pane.label,
      detail: options.backendLabel(pane.sessionBackend),
      backend: pane.sessionBackend,
      active: tab.id === options.activeTabId && pane.id === tab.activePaneId,
    })),
  }));
}
