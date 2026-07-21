import type { MessageKey } from "./i18n";
import { boolField, stringField } from "./json-meta.ts";
import type { JsonRecord } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function herdrEventMessage(event: string, data: JsonRecord, tr: Translate): string {
  if (event === "pane.agent_status_changed") {
    const status = stringField(data, "agent_status") || stringField(data, "state");
    const agent = stringField(data, "display_agent") || stringField(data, "agent") || "agent";
    const detail = stringField(data, "message") || status;
    return tr("status.herdrEventAgent", { agent, status: detail || status || "updated" });
  }
  if (event === "pane.agent_detected") {
    const agent = stringField(data, "agent") || "agent";
    if (boolField(data, "released")) {
      const finalStatus = stringField(data, "final_status");
      return finalStatus
        ? tr("status.herdrAgentReleasedWithStatus", { agent, status: finalStatus })
        : tr("status.herdrAgentReleased", { agent });
    }
    return tr("status.herdrAgentDetected", { agent });
  }
  const subject = stringField(data, "pane_id")
    || stringField(data, "tab_id")
    || stringField(data, "workspace_id")
    || event;
  return tr("status.herdrEvent", { event, subject });
}
