import type { MessageKey } from "../i18n";
import { TERMINAL_SHADER_EFFECTS } from "./options";
import type { TerminalShaderEffect } from "../types";
import { escapeAttr, escapeHtml } from "../utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type TerminalShaderSettingsViewState = {
  selected: TerminalShaderEffect;
  tr: Translate;
};

export function renderTerminalShaderSettings(state: TerminalShaderSettingsViewState): string {
  const options = TERMINAL_SHADER_EFFECTS.map((effect) => `
    <option value="${escapeAttr(effect.id)}" ${effect.id === state.selected ? "selected" : ""}>
      ${escapeHtml(state.tr(effect.labelKey))}
    </option>
  `).join("");
  return `
    <label class="field">
      <span>${escapeHtml(state.tr("field.terminalShaderEffect"))}</span>
      <select data-terminal-shader-effect>
        ${options}
      </select>
    </label>
    <p class="settings-help">${escapeHtml(state.tr("setting.terminalShaderHelp"))}</p>
  `;
}
