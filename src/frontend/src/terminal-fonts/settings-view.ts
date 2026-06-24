import type { MessageKey } from "../i18n";
import type { Settings } from "../types";
import { escapeAttr, escapeHtml } from "../utils";
import { FONT_HINT_TARGETS } from "./options";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type TerminalFontSettingsViewState = {
  settings: Pick<Settings, "fontLigatures" | "fontHinting" | "fontHintTarget">;
  tr: Translate;
};

export function renderTerminalFontRenderingSettings(state: TerminalFontSettingsViewState): string {
  const hintTargetOptions = FONT_HINT_TARGETS.map((target) => `
    <option value="${escapeAttr(target.id)}" ${target.id === state.settings.fontHintTarget ? "selected" : ""}>
      ${escapeHtml(state.tr(target.labelKey))}
    </option>
  `).join("");
  return `
    <div class="font-rendering-options">
      <label class="switch">
        <input id="fontLigatures" type="checkbox" ${state.settings.fontLigatures ? "checked" : ""} />
        <span>${escapeHtml(state.tr("setting.fontLigatures"))}</span>
      </label>
      <label class="switch">
        <input id="fontHinting" type="checkbox" ${state.settings.fontHinting ? "checked" : ""} />
        <span>${escapeHtml(state.tr("setting.fontHinting"))}</span>
      </label>
      <label class="field font-hint-target">
        <span>${escapeHtml(state.tr("field.fontHintTarget"))}</span>
        <select id="fontHintTarget" ${state.settings.fontHinting ? "" : "disabled"}>
          ${hintTargetOptions}
        </select>
      </label>
      <p class="settings-help">${escapeHtml(state.tr("setting.fontRenderingHelp"))}</p>
    </div>
  `;
}
