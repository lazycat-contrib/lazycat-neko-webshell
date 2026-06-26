import type { MessageKey } from "../../i18n";
import { escapeHtml } from "../../utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export const WHITE_NOISE_FLOATING_CONTROLS_METADATA = "floatingControls";
export const WHITE_NOISE_AUTO_PLAY_ON_SELECT_METADATA = "autoPlayOnSelect";

export type WhiteNoiseSettingsViewState = {
  autoPlayOnSelect: boolean;
  floatingControls: boolean;
  disabled: boolean;
  tr: Translate;
};

export function renderWhiteNoiseSettingsView(state: WhiteNoiseSettingsViewState): string {
  return `
    <div class="plugin-subsettings">
      <label class="switch">
        <input
          type="checkbox"
          data-white-noise-setting="floatingControls"
          ${state.floatingControls ? "checked" : ""}
          ${state.disabled ? "disabled" : ""}
        />
        <span>${escapeHtml(state.tr("setting.whiteNoiseFloatingControls"))}</span>
      </label>
      <p class="settings-help">${escapeHtml(state.tr("setting.whiteNoiseFloatingControlsHelp"))}</p>
      <label class="switch">
        <input
          type="checkbox"
          data-white-noise-setting="autoPlayOnSelect"
          ${state.autoPlayOnSelect ? "checked" : ""}
          ${state.disabled ? "disabled" : ""}
        />
        <span>${escapeHtml(state.tr("setting.whiteNoiseAutoPlayOnSelect"))}</span>
      </label>
      <p class="settings-help">${escapeHtml(state.tr("setting.whiteNoiseAutoPlayOnSelectHelp"))}</p>
    </div>
  `;
}

export function whiteNoiseFloatingControlsEnabled(metadata: Record<string, string>): boolean {
  return metadata[WHITE_NOISE_FLOATING_CONTROLS_METADATA] !== "false";
}

export function whiteNoiseAutoPlayOnSelectEnabled(metadata: Record<string, string>): boolean {
  return metadata[WHITE_NOISE_AUTO_PLAY_ON_SELECT_METADATA] !== "false";
}
