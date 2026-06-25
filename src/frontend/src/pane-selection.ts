import type { SessionMode } from "./session-backends";
import type { TerminalPane, TerminalTab } from "./types";
import { normalizeSelector } from "./workspace-selection";

export function selectActiveTab(tabs: TerminalTab[], activeTabId: string | undefined): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === activeTabId);
}

export function selectActivePane(tab: TerminalTab | undefined): TerminalPane | undefined {
  if (!tab) return undefined;
  return tab.panes.find((pane) => pane.id === tab.activePaneId) ?? tab.panes[0];
}

export function allTabPanes(tabs: TerminalTab[]): TerminalPane[] {
  return tabs.flatMap((tab) => tab.panes);
}

export function visibleTabPanes(tab: TerminalTab): TerminalPane[] {
  return tab.panes.filter((pane) => !pane.closing);
}

export function findPaneById(tabs: TerminalTab[], id: string): TerminalPane | undefined {
  return allTabPanes(tabs).find((pane) => pane.id === id);
}

export function tabForPane(tabs: TerminalTab[], pane: TerminalPane): TerminalTab | undefined {
  return tabs.find((tab) => tab.id === pane.tabId);
}

export function findPaneBySessionBackend(
  tabs: TerminalTab[],
  selector: string,
  mode: SessionMode,
): { tab: TerminalTab; pane: TerminalPane } | undefined {
  const normalizedSelector = normalizeSelector(selector);
  const sameSelectorTabs = tabs.filter((tab) => !tab.closing && normalizeSelector(tab.selector) === normalizedSelector);
  for (const tab of sameSelectorTabs) {
    const pane = selectActivePane(tab);
    if (pane && reusableBackendPane(tab, pane, mode)) return { tab, pane };
  }
  for (const tab of sameSelectorTabs) {
    const pane = tab.panes.find((item) => reusableBackendPane(tab, item, mode));
    if (pane) return { tab, pane };
  }
  return undefined;
}

function reusableBackendPane(tab: TerminalTab, pane: TerminalPane, mode: SessionMode): boolean {
  return !tab.closing
    && !pane.closing
    && pane.sessionBackend === mode
    && Boolean(pane.sessionId)
    && pane.sessionStatus !== "closed";
}
