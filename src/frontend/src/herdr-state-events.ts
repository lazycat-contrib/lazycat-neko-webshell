import { stringField } from "./json-meta.ts";
import { herdrPaneInfoFromEvent, herdrWorkspaceInfoFromEvent } from "./herdr-socket-api.ts";
import type { HerdrBridgeState, JsonRecord } from "./types";

export type HerdrResourceEventResult = {
  state: HerdrBridgeState;
  applied: boolean;
};

export function applyHerdrWorkspaceFocus(
  state: HerdrBridgeState,
  workspaceId: string,
): HerdrResourceEventResult {
  const workspace = state.workspaces.find((item) => item.workspace_id === workspaceId);
  if (!workspace) return { state, applied: false };
  const activeTab = state.tabs.find((tab) => (
    tab.workspace_id === workspaceId && tab.tab_id === workspace.active_tab_id
  ));
  const activeTabPanes = activeTab
    ? state.panes.filter((pane) => pane.tab_id === activeTab.tab_id)
    : [];
  const activePane = activeTabPanes.find((pane) => pane.focused)
    ?? (activeTabPanes.length === 1 ? activeTabPanes[0] : undefined);
  return {
    state: {
      ...state,
      workspaces: state.workspaces.map((item) => ({
        ...item,
        focused: item.workspace_id === workspaceId,
      })),
      tabs: state.tabs.map((tab) => ({
        ...tab,
        focused: tab.tab_id === activeTab?.tab_id,
      })),
      panes: state.panes.map((pane) => ({
        ...pane,
        focused: pane.pane_id === activePane?.pane_id,
      })),
      agents: state.agents.map((agent) => ({
        ...agent,
        focused: agent.pane_id === activePane?.pane_id,
      })),
    },
    applied: true,
  };
}

export function applyHerdrTabFocus(
  state: HerdrBridgeState,
  tabId: string,
): HerdrResourceEventResult {
  const tab = state.tabs.find((item) => item.tab_id === tabId);
  if (!tab) return { state, applied: false };
  const tabPanes = state.panes.filter((pane) => pane.tab_id === tabId);
  const focusedPane = tabPanes.length === 1 ? tabPanes[0] : undefined;
  return {
    state: {
      ...state,
      workspaces: state.workspaces.map((workspace) => ({
        ...workspace,
        focused: workspace.workspace_id === tab.workspace_id,
        active_tab_id: workspace.workspace_id === tab.workspace_id ? tab.tab_id : workspace.active_tab_id,
      })),
      tabs: state.tabs.map((item) => ({
        ...item,
        focused: item.tab_id === tab.tab_id,
      })),
      panes: state.panes.map((pane) => ({
        ...pane,
        focused: pane.pane_id === focusedPane?.pane_id,
      })),
      agents: state.agents.map((agent) => ({
        ...agent,
        focused: agent.pane_id === focusedPane?.pane_id,
      })),
    },
    applied: true,
  };
}

export function applyHerdrPaneFocus(
  state: HerdrBridgeState,
  paneId: string,
  workspaceId?: string,
): HerdrResourceEventResult {
  const pane = state.panes.find((item) => item.pane_id === paneId);
  if (!pane || (workspaceId && workspaceId !== pane.workspace_id)) {
    return { state, applied: false };
  }
  return {
    state: {
      ...state,
      workspaces: state.workspaces.map((workspace) => ({
        ...workspace,
        focused: workspace.workspace_id === pane.workspace_id,
        active_tab_id: workspace.workspace_id === pane.workspace_id ? pane.tab_id : workspace.active_tab_id,
      })),
      tabs: state.tabs.map((tab) => ({
        ...tab,
        focused: tab.tab_id === pane.tab_id,
      })),
      panes: state.panes.map((item) => ({
        ...item,
        focused: item.pane_id === pane.pane_id,
      })),
      agents: state.agents.map((agent) => ({
        ...agent,
        focused: agent.pane_id === pane.pane_id,
      })),
    },
    applied: true,
  };
}

export function applyHerdrResourceEvent(
  state: HerdrBridgeState,
  event: string,
  data: JsonRecord,
): HerdrResourceEventResult {
  if (event === "workspace.focused") {
    const workspaceId = stringField(data, "workspace_id");
    return workspaceId
      ? applyHerdrWorkspaceFocus(state, workspaceId)
      : { state, applied: false };
  }

  if (event === "tab.focused") {
    const tabId = stringField(data, "tab_id");
    const tab = state.tabs.find((item) => item.tab_id === tabId);
    const eventWorkspaceId = stringField(data, "workspace_id");
    if (!tab || (eventWorkspaceId && eventWorkspaceId !== tab.workspace_id)) {
      return { state, applied: false };
    }
    return applyHerdrTabFocus(state, tabId);
  }

  if (event === "pane.focused") {
    const paneId = stringField(data, "pane_id");
    const eventWorkspaceId = stringField(data, "workspace_id");
    return paneId
      ? applyHerdrPaneFocus(state, paneId, eventWorkspaceId)
      : { state, applied: false };
  }

  if (event === "workspace.metadata_updated") {
    const workspace = herdrWorkspaceInfoFromEvent(data);
    if (!workspace || !state.workspaces.some((item) => item.workspace_id === workspace.workspace_id)) {
      return { state, applied: false };
    }
    return {
      state: {
        ...state,
        workspaces: state.workspaces.map((item) => (
          item.workspace_id === workspace.workspace_id ? workspace : item
        )),
      },
      applied: true,
    };
  }

  if (event === "pane.updated") {
    const pane = herdrPaneInfoFromEvent(data);
    if (!pane || !state.panes.some((item) => item.pane_id === pane.pane_id)) {
      return { state, applied: false };
    }
    return {
      state: {
        ...state,
        panes: state.panes.map((item) => item.pane_id === pane.pane_id ? pane : item),
      },
      applied: true,
    };
  }

  return { state, applied: false };
}
