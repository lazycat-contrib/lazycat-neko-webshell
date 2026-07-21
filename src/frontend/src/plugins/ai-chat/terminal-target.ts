import type { MessageKey } from "../../i18n";
import type {
  AIChatTerminalTarget,
  HerdrAgentInfo,
  HerdrBridgeState,
  HerdrPaneInfo,
  HerdrTabInfo,
  HerdrWorkspaceInfo,
  TerminalPane,
  TerminalTab,
} from "../../types";
import { herdrAgentInteractionsAvailable, herdrAgentLabel } from "../../herdr-agent-view.ts";
import { normalizeSelector } from "../../workspace-selection.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type AIChatTerminalTargetOptions = {
  pane: TerminalPane | undefined;
  tab: TerminalTab | undefined;
  selectedSelector: string;
  herdrState: HerdrBridgeState | undefined;
  tabDisplayName: (tab: TerminalTab) => string;
  tr: Translate;
};

export type AIChatTerminalTargetResolverDeps = {
  pane: () => TerminalPane | undefined;
  tab: (pane: TerminalPane | undefined) => TerminalTab | undefined;
  selectedSelector: () => string;
  herdrState: () => HerdrBridgeState | undefined;
  tabDisplayName: (tab: TerminalTab) => string;
  tr: Translate;
};

export type AIChatTabTerminalTargetsOptions = Omit<AIChatTerminalTargetOptions, "pane"> & {
  tab: TerminalTab;
};

export function createAIChatTerminalTargetResolver(
  deps: AIChatTerminalTargetResolverDeps,
): () => AIChatTerminalTarget | undefined {
  return () => {
    const pane = deps.pane();
    return buildAIChatTerminalTarget({
      pane,
      tab: deps.tab(pane),
      selectedSelector: deps.selectedSelector(),
      herdrState: deps.herdrState(),
      tabDisplayName: deps.tabDisplayName,
      tr: deps.tr,
    });
  };
}

export function buildAIChatTerminalTargetsForTab(options: AIChatTabTerminalTargetsOptions): AIChatTerminalTarget[] {
  const targets = options.tab.panes
    .map((pane) => buildAIChatTerminalTarget({ ...options, pane }))
    .filter((target): target is AIChatTerminalTarget => Boolean(target));
  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.key)) return false;
    seen.add(target.key);
    return true;
  });
}

export function buildAIChatTerminalTarget(options: AIChatTerminalTargetOptions): AIChatTerminalTarget | undefined {
  const { pane, tab, selectedSelector, herdrState, tabDisplayName, tr } = options;
  if (!pane || pane.closing) return undefined;
  const selector = normalizeSelector(pane.selector || tab?.selector || selectedSelector);
  if (!selector) return undefined;
  if (pane.sessionBackend === "herdr") {
    const workspace = focusedHerdrWorkspace(herdrState);
    const herdrTab = focusedHerdrTab(herdrState);
    const herdrAgent = focusedHerdrAgent(herdrState);
    return {
      key: [
        selector,
        pane.sessionBackend,
        pane.sessionId || pane.id,
        workspace?.workspace_id || "workspace",
        herdrTab?.tab_id || "tab",
      ].join(":"),
      label: herdrTerminalTargetLabel({
        tab,
        pane,
        workspace,
        herdrTab,
        tabDisplayName,
        tr,
      }),
      ...(herdrAgent ? {
        herdrAgent: {
          target: herdrAgent.pane_id,
          label: herdrAgentLabel(herdrAgent),
          status: herdrAgent.agent_status,
          interactiveReady: herdrAgent.interactive_ready,
        },
      } : {}),
    };
  }
  return {
    key: [selector, pane.sessionBackend, pane.sessionId || pane.id, pane.id].join(":"),
    label: terminalTargetLabel({ tab, pane, tabDisplayName, tr }),
  };
}

function focusedHerdrWorkspace(state: HerdrBridgeState | undefined): HerdrWorkspaceInfo | undefined {
  return state?.workspaces.find((workspace) => workspace.focused) ?? state?.workspaces[0];
}

function focusedHerdrTab(state: HerdrBridgeState | undefined): HerdrTabInfo | undefined {
  return state?.tabs.find((tab) => tab.focused) ?? state?.tabs[0];
}

function focusedHerdrAgent(state: HerdrBridgeState | undefined): HerdrAgentInfo | undefined {
  if (!herdrAgentInteractionsAvailable(state)) return undefined;
  const pane = focusedHerdrPane(state);
  return state?.agents.find((agent) => agent.pane_id === pane?.pane_id)
    ?? state?.agents.find((agent) => agent.focused);
}

function focusedHerdrPane(state: HerdrBridgeState | undefined): HerdrPaneInfo | undefined {
  return state?.panes.find((pane) => pane.focused) ?? state?.panes[0];
}

function herdrTerminalTargetLabel(options: {
  tab: TerminalTab | undefined;
  pane: TerminalPane;
  workspace: HerdrWorkspaceInfo | undefined;
  herdrTab: HerdrTabInfo | undefined;
  tabDisplayName: (tab: TerminalTab) => string;
  tr: Translate;
}): string {
  const { tab, pane, workspace, herdrTab, tabDisplayName, tr } = options;
  const workspaceLabel = workspace?.label.trim() || (tab ? tabDisplayName(tab) : "") || tr("backend.herdr");
  const herdrTabLabel = herdrTab?.label.trim() || (herdrTab?.number ? tr("tab.terminalSession", { index: herdrTab.number }) : "");
  return [workspaceLabel, herdrTabLabel].filter(Boolean).join(" · ")
    || terminalTargetLabel({ tab, pane, tabDisplayName, tr });
}

function terminalTargetLabel(options: {
  tab: TerminalTab | undefined;
  pane: TerminalPane;
  tabDisplayName: (tab: TerminalTab) => string;
  tr: Translate;
}): string {
  const { tab, pane, tabDisplayName, tr } = options;
  const tabLabel = tab ? tabDisplayName(tab) : "";
  const paneTitle = pane.title.trim();
  const visiblePaneCount = tab?.panes.filter((item) => !item.closing).length ?? 0;
  if (tab && visiblePaneCount > 1 && paneTitle && paneTitle !== tabLabel) {
    return [tabLabel, paneTitle].filter(Boolean).join(" · ");
  }
  return tabLabel || paneTitle || pane.label || pane.sessionId || tr("tab.terminal");
}
