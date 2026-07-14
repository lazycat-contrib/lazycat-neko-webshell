import type { SplitNode } from "./types";
import { normalizeSelector } from "./workspace-selection.ts";
import { workspaceLayoutToRaw } from "./workspace-identity.ts";

type WorkspaceActionPane = {
  id: string;
  selector: string;
  workspacePaneId: string;
};

type WorkspaceActionTab = {
  id: string;
  selector: string;
  workspaceTabId: string;
  panes: WorkspaceActionPane[];
};

export type WorkspaceActionViewTarget = {
  tabId?: string;
  paneId?: string;
  layout?: SplitNode;
  activePaneId?: string;
};

export function resolveWorkspaceActionTarget(
  tabs: WorkspaceActionTab[],
  selector: string,
  options: WorkspaceActionViewTarget,
): WorkspaceActionViewTarget {
  const normalizedSelector = normalizeSelector(selector);
  const actionTab = options.tabId
    ? tabs.find((tab) => (
      tab.id === options.tabId
      && normalizeSelector(tab.selector) === normalizedSelector
    ))
    : undefined;
  const actionPane = options.paneId
    ? actionTab?.panes.find((pane) => pane.id === options.paneId)
      ?? tabs
        .filter((tab) => normalizeSelector(tab.selector) === normalizedSelector)
        .flatMap((tab) => tab.panes)
        .find((pane) => pane.id === options.paneId)
    : undefined;

  return {
    tabId: actionTab?.workspaceTabId,
    paneId: actionPane?.workspacePaneId,
    layout: options.layout ? workspaceLayoutToRaw(normalizedSelector, options.layout) : undefined,
    activePaneId: options.activePaneId
      ? actionTab?.panes.find((pane) => pane.id === options.activePaneId)?.workspacePaneId
      : undefined,
  };
}
