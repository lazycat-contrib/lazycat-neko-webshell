import type { HerdrAgentInfo, HerdrPaneInfo } from "../types";

export type HerdrNotificationKind = "blocked" | "done";

export type HerdrNotificationTransition = {
  kind: HerdrNotificationKind;
  paneId: string;
  workspaceId: string;
  agent: string;
  displayAgent: string;
};

// Event subscriptions can repeat retained statuses and presentation changes.
// Only authoritative snapshots may advance notification state.
export function createHerdrNotificationPolicy() {
  const paneStatuses = new Map<string, string>();
  const workingPanes = new Set<string>();
  const completions = new Map<string, { terminalId: string; sequence?: number }>();
  let useCompletionMarkers = false;
  let active = false;

  function rememberStatus(pane: HerdrPaneInfo) {
    const status = normalizeStatus(pane.agent_status);
    paneStatuses.set(pane.pane_id, status);
    if (status === "working") workingPanes.add(pane.pane_id);
  }

  return {
    seed(panes: readonly HerdrPaneInfo[], agents: readonly HerdrAgentInfo[] = [], completionMarkers = false) {
      active = true;
      useCompletionMarkers = completionMarkers;
      paneStatuses.clear();
      workingPanes.clear();
      completions.clear();
      for (const pane of snapshotPanes(panes, agents).values()) rememberStatus(pane);
      for (const agent of agents) {
        completions.set(agent.pane_id, { terminalId: agent.terminal_id, sequence: agent.completion_seq });
      }
    },

    reconcile(agents: readonly HerdrAgentInfo[], panes: readonly HerdrPaneInfo[] = []): HerdrNotificationTransition[] {
      if (!active) return [];
      const transitions: HerdrNotificationTransition[] = [];
      const currentPanes = snapshotPanes(panes, agents);
      const agentIds = new Set(agents.map((agent) => agent.pane_id));
      for (const paneId of paneStatuses.keys()) {
        if (!currentPanes.has(paneId)) {
          paneStatuses.delete(paneId);
          workingPanes.delete(paneId);
        }
      }
      for (const paneId of completions.keys()) {
        if (!agentIds.has(paneId)) completions.delete(paneId);
      }
      for (const agent of agents) {
        const previous = completions.get(agent.pane_id);
        const sameTerminal = previous?.terminalId === agent.terminal_id;
        completions.set(agent.pane_id, {
          terminalId: agent.terminal_id,
          // A temporarily missing marker must not make an old completion new.
          sequence: agent.completion_seq ?? (sameTerminal ? previous.sequence : undefined),
        });
        if (!sameTerminal) {
          workingPanes.delete(agent.pane_id);
          rememberStatus(agent);
        }
        if (!useCompletionMarkers || !sameTerminal
          || agent.completion_seq === undefined
          || (previous.sequence !== undefined && agent.completion_seq <= previous.sequence)) continue;
        transitions.push(transition("done", agent));
      }
      for (const pane of currentPanes.values()) {
        const previousStatus = paneStatuses.get(pane.pane_id);
        const status = normalizeStatus(pane.agent_status);
        rememberStatus(pane);
        const completedWork = status === "idle" && workingPanes.delete(pane.pane_id);
        if (status === "done" || status === "unknown") workingPanes.delete(pane.pane_id);
        if (previousStatus === undefined || previousStatus === status) continue;
        if (status === "blocked") transitions.push(transition("blocked", pane));
        else if (!useCompletionMarkers && (status === "done" || completedWork)) {
          transitions.push(transition("done", pane));
        }
      }
      return transitions;
    },

    reset() {
      active = false;
      paneStatuses.clear();
      workingPanes.clear();
      completions.clear();
    },
  };
}

function snapshotPanes(panes: readonly HerdrPaneInfo[], agents: readonly HerdrAgentInfo[]) {
  return new Map<string, HerdrPaneInfo>([...panes, ...agents].map((pane) => [pane.pane_id, pane]));
}

function transition(kind: HerdrNotificationKind, pane: HerdrPaneInfo): HerdrNotificationTransition {
  return {
    kind, paneId: pane.pane_id, workspaceId: pane.workspace_id,
    agent: pane.agent ?? "", displayAgent: pane.display_agent ?? "",
  };
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}
