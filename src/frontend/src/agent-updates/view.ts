import type { MessageKey } from "../i18n";
import { escapeHtml } from "../utils.ts";
import type { AgentUpdateStatus } from "./api.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
export type AgentUpdateViewState = { status?: AgentUpdateStatus; busy: boolean; error?: string };

export function renderAgentUpdateView(state: AgentUpdateViewState, tr: Translate): string {
  const { status, busy, error } = state;
  const kind = status?.kind;
  const description = error ? "agentUpdate.failed" : busy ? "agentUpdate.updating"
    : kind === "optional" ? "agentUpdate.optionalHelp" : kind === "pending_restart" ? "agentUpdate.pendingHelp"
    : kind === "provider_older" ? "agentUpdate.providerOlder" : "agentUpdate.readyHelp";
  return `<div class="settings-group-title">${escapeHtml(tr("agentUpdate.title"))}</div>
    <p class="settings-help" data-agent-update-status tabindex="-1" role="status" aria-live="polite">${escapeHtml(tr(description))}</p>
    ${status?.currentVersion ? `<p class="agent-update-version">${escapeHtml(tr("agentUpdate.versions", {
      current: String(status.currentVersion), latest: String(status.latestVersion),
    }))}</p>` : ""}
    <div class="agent-update-actions">
      ${kind === "optional" && !busy ? `<button type="button" class="command-button primary" data-agent-update="prepare">${escapeHtml(tr("agentUpdate.prepare"))}</button>
        <button type="button" class="command-button" data-agent-update="later">${escapeHtml(tr("agentUpdate.later"))}</button>` : ""}
      <button type="button" class="command-button" data-agent-update="check" ${busy ? "disabled" : ""}>${escapeHtml(tr(error ? "agentUpdate.retry" : "agentUpdate.check"))}</button>
    </div>`;
}
