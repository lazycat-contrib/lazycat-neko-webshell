import type { TerminalPane, TerminalTab, WorkspacePaneState, WorkspaceState } from "./types";
import { normalizeSelector } from "./workspace-selection.ts";
import { workspaceEntityId, workspaceLayoutToView } from "./workspace-identity.ts";
import { replaceSelectorTabs } from "./workspace-collection.ts";

/** Commit the snapshot synchronously, before asynchronous terminal mounting can yield. */
export function reconcileWorkspace(options: {
  workspace: WorkspaceState;
  selector: string;
  tabs: TerminalTab[];
  activeTabId?: string;
  preserveFocus: boolean;
  replayPaneId?: string;
  passive?: boolean;
  markPassive?: (pane: TerminalPane, passive: boolean) => void;
  makeTab: (selector: string, id: string) => TerminalTab;
  restorePane: (tab: TerminalTab, state: WorkspacePaneState, existing?: TerminalPane, replay?: boolean) => TerminalPane;
  disposePane: (pane: TerminalPane) => void;
  attachTab: (tab: TerminalTab) => void;
  renderLayout: (tab: TerminalTab) => void;
}) {
  const { selector, workspace } = options;
  const previous = options.tabs.filter((tab) => normalizeSelector(tab.selector) === selector);
  const oldTabs = new Map(previous.map((tab) => [tab.id, tab]));
  const oldPanes = new Map(previous.flatMap((tab) => tab.panes.map((pane) => [pane.id, pane] as const)));
  const retained = new Set<string>();
  const toMount: TerminalPane[] = [];
  const replacements = workspace.tabs.map((state) => {
    const id = workspaceEntityId(selector, "tab", state.id);
    const existing = oldTabs.get(id);
    const tab = existing ?? options.makeTab(selector, state.id);
    const oldPaneList = tab.panes;
    const oldLayout = JSON.stringify(tab.layout);
    tab.customTitle = state.custom_label?.trim() || undefined;
    tab.pinned = state.pinned === true;
    tab.pinnedOrder = typeof state.pinned_order === "number" ? state.pinned_order : undefined;
    tab.panes = state.panes.map((paneState) => {
      const paneId = workspaceEntityId(selector, "pane", paneState.id);
      const pane = options.restorePane(tab, paneState, oldPanes.get(paneId),
        paneId === options.replayPaneId || (!options.passive && oldPanes.get(paneId)?.workspaceRefreshPending === true));
      if (pane !== oldPanes.get(paneId) || !options.passive) options.markPassive?.(pane, options.passive === true);
      retained.add(pane.id);
      if (!pane.term) toMount.push(pane);
      return pane;
    });
    if (oldPaneList.length === tab.panes.length && oldPaneList.every((pane, index) => pane === tab.panes[index])) {
      tab.panes = oldPaneList;
    }
    const preserveFocus = options.preserveFocus || state.id !== workspace.active_tab_id;
    if (!preserveFocus || !tab.panes.some((pane) => pane.id === tab.activePaneId)) {
      const requested = state.active_pane_id && workspaceEntityId(selector, "pane", state.active_pane_id);
      tab.activePaneId = tab.panes.find((pane) => pane.id === requested)?.id ?? tab.panes[0]?.id;
    }
    const nextLayout = workspaceLayoutToView(selector, state.layout)
      ?? (tab.panes[0] ? { type: "pane" as const, paneId: tab.panes[0].id } : undefined);
    const layoutChanged = oldLayout !== JSON.stringify(nextLayout);
    if (layoutChanged) tab.layout = nextLayout;
    if (!existing) options.attachTab(tab);
    if (!existing || layoutChanged || oldPaneList.length !== tab.panes.length
      || oldPaneList.some((pane, index) => pane !== tab.panes[index])) options.renderLayout(tab);
    return tab;
  });
  const retainedTabs = new Set(replacements);
  for (const tab of previous) if (!retainedTabs.has(tab)) tab.mount.remove();
  for (const [id, pane] of oldPanes) if (!retained.has(id)) options.disposePane(pane);
  return {
    tabs: replaceSelectorTabs(options.tabs, selector, replacements, options.activeTabId),
    toMount,
    panes: replacements.flatMap((tab) => tab.panes),
  };
}
