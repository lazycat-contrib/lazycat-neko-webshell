import { stringField } from "../json-meta.ts";
import type { HerdrAgentInfo, HerdrPaneInfo, JsonRecord } from "../types";

export type HerdrNotificationKind = "blocked" | "done";

export type HerdrNotificationTransition = {
  kind: HerdrNotificationKind;
  paneId: string;
  workspaceId: string;
  agent: string;
  displayAgent: string;
};

const NOTIFIABLE_STATUSES = new Set<HerdrNotificationKind>(["blocked", "done"]);

export function createHerdrNotificationPolicy() {
  const paneStatuses = new Map<string, string>();
  const workingPanes = new Set<string>();
  const completions = new Map<string, { terminalId: string; sequence?: number }>();
  const notifiedCompletions = new Map<string, "wire" | "snapshot">();
  let useCompletionMarkers = false;
  let active = false;

  return {
    seed(panes: readonly HerdrPaneInfo[], agents: readonly HerdrAgentInfo[] = [], completionMarkers = false) {
      active = true;
      useCompletionMarkers = completionMarkers;
      paneStatuses.clear();
      workingPanes.clear();
      completions.clear();
      notifiedCompletions.clear();
      for (const pane of panes) {
        const status = normalizeStatus(pane.agent_status);
        if (pane.pane_id && status) paneStatuses.set(pane.pane_id, status);
        if (status === "working") workingPanes.add(pane.pane_id);
      }
      for (const agent of agents) {
        completions.set(agent.pane_id, { terminalId: agent.terminal_id, sequence: agent.completion_seq });
      }
    },

    handle(event: string, data: JsonRecord): HerdrNotificationTransition | undefined {
      if (event !== "pane.agent_status_changed") return undefined;
      const paneId = stringField(data, "pane_id");
      const status = normalizeStatus(stringField(data, "agent_status"));
      if (!paneId || !status) return undefined;

      const previousStatus = paneStatuses.get(paneId);
      paneStatuses.set(paneId, status);
      if (status === "working") workingPanes.add(paneId);
      if (status === "working") notifiedCompletions.delete(paneId);
      const completedWork = status === "idle" && workingPanes.delete(paneId);
      if (status === "done" || status === "unknown") workingPanes.delete(paneId);
      const kind = status === "idle"
        && completedWork
        ? "done"
        : status;
      if (
        previousStatus === undefined
        || previousStatus === status
        || !NOTIFIABLE_STATUSES.has(kind as HerdrNotificationKind)
        || (useCompletionMarkers && kind === "done" && status !== "done")
      ) {
        return undefined;
      }
      if (useCompletionMarkers && kind === "done") {
        if (notifiedCompletions.get(paneId) === "snapshot") return undefined;
        notifiedCompletions.set(paneId, "wire");
      }

      return {
        kind: kind as HerdrNotificationKind,
        paneId,
        workspaceId: stringField(data, "workspace_id"),
        agent: stringField(data, "agent"),
        displayAgent: stringField(data, "display_agent"),
      };
    },

    reconcile(agents: readonly HerdrAgentInfo[]): HerdrNotificationTransition[] {
      if (!active || !useCompletionMarkers) return [];
      const transitions: HerdrNotificationTransition[] = [];
      const paneIds = new Set(agents.map((agent) => agent.pane_id));
      for (const paneId of completions.keys()) {
        if (!paneIds.has(paneId)) {
          completions.delete(paneId);
          notifiedCompletions.delete(paneId);
        }
      }
      for (const agent of agents) {
        const previous = completions.get(agent.pane_id);
        completions.set(agent.pane_id, { terminalId: agent.terminal_id, sequence: agent.completion_seq });
        if (previous?.terminalId !== agent.terminal_id || agent.agent_status === "working") {
          notifiedCompletions.delete(agent.pane_id);
        }
        if (previous?.terminalId !== agent.terminal_id
          || agent.completion_seq === undefined
          || (previous.sequence !== undefined && agent.completion_seq <= previous.sequence)
          || (agent.agent_status !== "idle" && agent.agent_status !== "done")) continue;
        if (notifiedCompletions.get(agent.pane_id) === "wire") {
          notifiedCompletions.delete(agent.pane_id);
          continue;
        }
        notifiedCompletions.set(agent.pane_id, "snapshot");
        transitions.push({
          kind: "done", paneId: agent.pane_id, workspaceId: agent.workspace_id,
          agent: agent.agent ?? "", displayAgent: agent.display_agent ?? "",
        });
      }
      return transitions;
    },

    reset() {
      active = false;
      paneStatuses.clear();
      workingPanes.clear();
      completions.clear();
      notifiedCompletions.clear();
    },
  };
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}
