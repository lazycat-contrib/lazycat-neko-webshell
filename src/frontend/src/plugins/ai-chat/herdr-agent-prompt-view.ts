import type { MessageKey } from "../../i18n";
import { escapeAttr, escapeHtml } from "../../utils.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderHerdrAgentPromptButton(options: {
  available: boolean;
  busy: boolean;
  tr: Translate;
}): string {
  if (!options.available) return "";
  const label = options.tr("action.aiSendToHerdrAgent");
  return `
    <button class="command-button" type="button" data-ai-action="send-herdr-agent" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}" ${options.busy ? "disabled" : ""}>
      <i data-lucide="bot-message-square"></i>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}
