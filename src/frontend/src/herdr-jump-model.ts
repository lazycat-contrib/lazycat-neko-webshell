import type { HerdrBridgeState, HerdrPaneInfo, HerdrTabInfo, HerdrWorkspaceInfo } from "./types.ts";
import { herdrAgentIconKey, type HerdrAgentIconKey } from "./herdr-agent-icons.ts";

const MAX_HERDR_DISPLAY_TEXT_LENGTH = 160;

export type HerdrJumpDensity = "compact" | "normal";
export type HerdrJumpDevice = "desktop" | "mobile";

export type HerdrJumpTarget = {
  paneId?: string;
  workspaceId: string;
  tabId: string;
  sequence: string;
  label: string;
  title: string;
  icon?: HerdrAgentIconKey;
  status: string;
  current: boolean;
  duplicate: boolean;
};

export type HerdrJumpGroup = {
  workspaceId: string;
  label: string;
  number: string;
  current: boolean;
  targets: HerdrJumpTarget[];
};

export type HerdrJumpModel = {
  groups: HerdrJumpGroup[];
  currentWorkspace?: HerdrJumpGroup;
  currentTarget?: HerdrJumpTarget;
};

export type HerdrJumpModelLabels = {
  workspace: (number: string) => string;
  workspaceDefault: string;
  tab: (number: string) => string;
  tabDefault: string;
  terminal: string;
};

export function defaultHerdrJumpDensity(device: HerdrJumpDevice): HerdrJumpDensity {
  return device === "mobile" ? "compact" : "normal";
}

export function normalizeHerdrJumpDensity(
  value: string | null | undefined,
  device: HerdrJumpDevice,
): HerdrJumpDensity {
  return value === "compact" || value === "normal" ? value : defaultHerdrJumpDensity(device);
}

export function buildHerdrJumpModel(
  state: Pick<HerdrBridgeState, "workspaces" | "tabs" | "panes"> | undefined,
  labels: HerdrJumpModelLabels,
): HerdrJumpModel {
  const workspaces = state?.workspaces ?? [];
  const tabs = state?.tabs ?? [];
  const panes = state?.panes ?? [];
  const groups = workspaces.map((workspace) => groupForWorkspace(workspace, tabs, panes, labels));
  const currentWorkspace = groups.find((group) => group.current) ?? groups[0];
  const currentTarget = currentWorkspace?.targets.find((target) => target.current);
  return { groups, currentWorkspace, currentTarget };
}

function groupForWorkspace(
  workspace: HerdrWorkspaceInfo,
  tabs: HerdrTabInfo[],
  panes: HerdrPaneInfo[],
  labels: HerdrJumpModelLabels,
): HerdrJumpGroup {
  const listedTabs = tabs.filter((tab) => tab.workspace_id === workspace.workspace_id);
  const listedTabIds = new Set(listedTabs.map((tab) => tab.tab_id));
  const missingTabs = new Map<string, HerdrPaneInfo[]>();
  for (const pane of panes) {
    if (pane.workspace_id !== workspace.workspace_id || listedTabIds.has(pane.tab_id)) continue;
    const tabPanes = missingTabs.get(pane.tab_id) ?? [];
    tabPanes.push(pane);
    missingTabs.set(pane.tab_id, tabPanes);
  }
  const workspaceTabs = [
    ...listedTabs,
    ...Array.from(missingTabs, ([tabId, tabPanes]) => ({
      tab_id: tabId,
      workspace_id: workspace.workspace_id,
      number: 0,
      label: "",
      focused: tabPanes.some((pane) => pane.focused),
      pane_count: tabPanes.length,
    })),
  ];
  const targets = workspaceTabs.flatMap((tab) => targetsForTab(workspace, tab, panes, labels));
  const labelCounts = new Map<string, number>();
  for (const target of targets) {
    const key = target.label.toLocaleLowerCase();
    labelCounts.set(key, (labelCounts.get(key) ?? 0) + 1);
  }
  for (const target of targets) {
    target.duplicate = (labelCounts.get(target.label.toLocaleLowerCase()) ?? 0) > 1;
  }
  const number = positiveNumberLabel(workspace.number);
  return {
    workspaceId: workspace.workspace_id,
    number,
    label: displayText(workspace.label) || fallbackLabel(number, labels.workspace, labels.workspaceDefault),
    current: workspace.focused,
    targets,
  };
}

function targetsForTab(
  workspace: HerdrWorkspaceInfo,
  tab: HerdrTabInfo,
  panes: HerdrPaneInfo[],
  labels: HerdrJumpModelLabels,
): HerdrJumpTarget[] {
  const tabPanes = panes.filter((pane) => pane.tab_id === tab.tab_id);
  const tabNumber = positiveNumberLabel(tab.number);
  const tabLabel = displayText(tab.label);
  if (!tabPanes.length) {
    const label = tabLabel || fallbackLabel(tabNumber, labels.tab, labels.tabDefault);
    return [{
      workspaceId: workspace.workspace_id,
      tabId: tab.tab_id,
      sequence: tabNumber || "?",
      label,
      title: uniqueNonEmpty([label, tabNumber]).join(" · "),
      status: "unknown",
      current: workspace.focused && tab.focused,
      duplicate: false,
    }];
  }
  return tabPanes.map((pane, paneIndex) => {
    const sequence = tabPanes.length > 1 ? `${tabNumber || "?"}.${paneIndex + 1}` : tabNumber || String(paneIndex + 1);
    const label = displayText(pane.display_agent)
      || displayText(pane.agent)
      || displayText(pane.title)
      || displayText(pane.terminal_title_stripped)
      || tabLabel
      || fallbackLabel(tabNumber, labels.tab, labels.terminal);
    const title = uniqueNonEmpty([
      label,
      tabLabel || labels.tab(tabNumber),
      sequence,
    ]).join(" · ");
    return {
      ...(tabPanes.length > 1 ? { paneId: pane.pane_id } : {}),
      workspaceId: workspace.workspace_id,
      tabId: tab.tab_id,
      sequence,
      label,
      title,
      icon: herdrAgentIconKey(pane.agent, [pane.display_agent, pane.title, pane.terminal_title_stripped]),
      status: displayText(pane.agent_status, 32) || "unknown",
      current: workspace.focused && tab.focused && pane.focused,
      duplicate: false,
    };
  });
}

function positiveNumberLabel(value: number): string {
  return Number.isFinite(value) && value > 0 ? String(value) : "";
}

function fallbackLabel(
  number: string,
  numbered: (number: string) => string,
  fallback: string,
): string {
  return number ? numbered(number).trim() || fallback : fallback;
}

function uniqueNonEmpty(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function displayText(value: string | undefined, maxLength = MAX_HERDR_DISPLAY_TEXT_LENGTH): string {
  const text = value?.trim() ?? "";
  if (text.length <= maxLength) return text;
  const truncated = text.slice(0, maxLength);
  return /[\uD800-\uDBFF]$/.test(truncated) ? truncated.slice(0, -1) : truncated;
}
