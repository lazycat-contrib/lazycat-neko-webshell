import { removePaneFromLayout } from "./split-layout.ts";
import type { WorkspaceState, WorkspaceTabState } from "./types";

export type ExitedPaneCleanupRequest = {
  selector: string;
  paneId: string;
};

type ExitedPaneCleanupOptions = {
  reconcile: (selector: string) => Promise<void>;
};

export type ExitedPaneCleanupController = {
  handle: (request: ExitedPaneCleanupRequest) => Promise<boolean>;
};

type PaneExitState = {
  exited: boolean;
  selector: string;
};

export function hasExitedPaneForSelector(
  panes: Iterable<PaneExitState>,
  selector: string,
): boolean {
  const normalizedSelector = selector.trim();
  return Boolean(normalizedSelector) && [...panes].some((pane) => (
    pane.exited && pane.selector.trim() === normalizedSelector
  ));
}

export function shouldApplyWorkspaceActionResponse(
  requestedApply: boolean | undefined,
  hasExitedPane: boolean,
): boolean {
  return requestedApply !== false || hasExitedPane;
}

export function createExitedPaneCleanupController(
  options: ExitedPaneCleanupOptions,
): ExitedPaneCleanupController {
  const activePanes = new Map<string, Set<string>>();
  const pendingPanes = new Map<string, Set<string>>();
  const runningSelectors = new Set<string>();

  return {
    async handle(request) {
      const selector = request.selector.trim();
      const paneId = request.paneId.trim();
      if (!selector || !paneId) return false;
      const pending = pendingPanes.get(selector) ?? new Set<string>();
      pendingPanes.set(selector, pending);
      if (activePanes.get(selector)?.has(paneId) || pending.has(paneId)) return false;
      pending.add(paneId);
      if (runningSelectors.has(selector)) return false;

      runningSelectors.add(selector);
      let reconciled = false;
      try {
        while (pending.size) {
          const batch = new Set(pending);
          pending.clear();
          activePanes.set(selector, batch);
          try {
            await options.reconcile(selector);
            reconciled = true;
          } catch {
            pending.clear();
            return false;
          } finally {
            activePanes.delete(selector);
          }
        }
        return reconciled;
      } finally {
        runningSelectors.delete(selector);
        if (!pending.size) pendingPanes.delete(selector);
      }
    },
  };
}

export function normalizeExitedWorkspaceState(
  workspace: WorkspaceState,
  remoteClient: boolean,
  protectedPaneIds: ReadonlySet<string> = new Set(),
  removableHerdrPaneIds: ReadonlySet<string> = new Set(),
  classifiableHerdrPaneIds: ReadonlySet<string> = new Set(),
): WorkspaceState {
  const tabs = workspace.tabs
    .map((tab) => normalizeExitedTab(
      tab,
      remoteClient,
      protectedPaneIds,
      removableHerdrPaneIds,
      classifiableHerdrPaneIds,
    ))
    .filter((tab): tab is WorkspaceTabState => Boolean(tab));
  const activeTabId = tabs.some((tab) => tab.id === workspace.active_tab_id)
    ? workspace.active_tab_id
    : tabs[0]?.id;
  return {
    ...workspace,
    active_tab_id: activeTabId,
    tabs,
  };
}

function normalizeExitedTab(
  tab: WorkspaceTabState,
  remoteClient: boolean,
  protectedPaneIds: ReadonlySet<string>,
  removableHerdrPaneIds: ReadonlySet<string>,
  classifiableHerdrPaneIds: ReadonlySet<string>,
): WorkspaceTabState | undefined {
  const exited = tab.panes.filter((pane) => pane.status === "exited");
  if (!exited.length) return tab;

  const runningPaneIds = new Set(
    tab.panes.filter((pane) => pane.status !== "exited").map((pane) => pane.id),
  );
  const keepableExited = exited.filter((pane) => (
    pane.session_backend !== "herdr"
    || protectedPaneIds.has(pane.id)
    || classifiableHerdrPaneIds.has(pane.id)
  ));
  const keepExitedPaneId = !remoteClient && !runningPaneIds.size
    ? keepableExited.find((pane) => pane.id === tab.active_pane_id)?.id
      ?? keepableExited.at(-1)?.id
    : undefined;
  const removedPaneIds = new Set(
    exited
      .filter((pane) => (
        pane.id !== keepExitedPaneId
        && !protectedPaneIds.has(pane.id)
        && (
          remoteClient
          || pane.session_backend !== "herdr"
          || removableHerdrPaneIds.has(pane.id)
          || !classifiableHerdrPaneIds.has(pane.id)
        )
      ))
      .map((pane) => pane.id),
  );
  if (!removedPaneIds.size) return tab;

  const panes = tab.panes.filter((pane) => !removedPaneIds.has(pane.id));
  if (!panes.length) return undefined;
  let layout = tab.layout;
  for (const paneId of removedPaneIds) {
    layout = removePaneFromLayout(layout, paneId);
  }
  const activePaneId = panes.some((pane) => pane.id === tab.active_pane_id)
    ? tab.active_pane_id
    : panes[0]?.id;
  return {
    ...tab,
    active_pane_id: activePaneId,
    layout,
    panes,
  };
}
