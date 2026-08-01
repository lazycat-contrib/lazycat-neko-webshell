import { stringField } from "../json-meta.ts";
import type { HerdrPaneInfo, JsonRecord } from "../types";

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

  return {
    seed(panes: readonly HerdrPaneInfo[]) {
      paneStatuses.clear();
      for (const pane of panes) {
        const status = normalizeStatus(pane.agent_status);
        if (pane.pane_id && status) paneStatuses.set(pane.pane_id, status);
      }
    },

    handle(event: string, data: JsonRecord): HerdrNotificationTransition | undefined {
      if (event !== "pane.agent_status_changed") return undefined;
      const paneId = stringField(data, "pane_id");
      const status = normalizeStatus(stringField(data, "agent_status"));
      if (!paneId || !status) return undefined;

      const previousStatus = paneStatuses.get(paneId);
      paneStatuses.set(paneId, status);
      const kind = status === "idle"
        && (previousStatus === "working" || previousStatus === "blocked")
        ? "done"
        : status;
      if (
        previousStatus === undefined
        || previousStatus === status
        || !NOTIFIABLE_STATUSES.has(kind as HerdrNotificationKind)
      ) {
        return undefined;
      }

      return {
        kind: kind as HerdrNotificationKind,
        paneId,
        workspaceId: stringField(data, "workspace_id"),
        agent: stringField(data, "agent"),
        displayAgent: stringField(data, "display_agent"),
      };
    },

    reset() {
      paneStatuses.clear();
    },
  };
}

function normalizeStatus(value: string): string {
  return value.trim().toLowerCase();
}
