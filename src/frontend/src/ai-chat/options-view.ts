import type { MessageKey } from "../i18n";
import { escapeAttr, escapeHtml } from "../utils.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type AIChatContextToggleState = {
  enabled: boolean;
  disabled: boolean;
  tr: Translate;
};

export function renderAIChatContextToggle(state: AIChatContextToggleState): string {
  const label = state.tr("setting.aiTerminalContext");
  return `
    <button
      class="ai-context-toggle"
      type="button"
      data-ai-action="toggle-terminal-context"
      aria-pressed="${state.enabled}"
      aria-label="${escapeAttr(label)}"
      title="${escapeAttr(label)}"
      ${state.disabled ? "disabled" : ""}
    >
      <i data-lucide="terminal"></i>
      <span class="ai-context-toggle-label">${escapeHtml(label)}</span>
    </button>
  `;
}
