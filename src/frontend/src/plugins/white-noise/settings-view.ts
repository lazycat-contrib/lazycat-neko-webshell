import type { MessageKey } from "../../i18n";
import { escapeHtml } from "../../utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export const WHITE_NOISE_FLOATING_CONTROLS_METADATA = "floatingControls";

export type WhiteNoiseSettingsViewState = {
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
    </div>
  `;
}

export function whiteNoiseFloatingControlsEnabled(metadata: Record<string, string>): boolean {
  return metadata[WHITE_NOISE_FLOATING_CONTROLS_METADATA] !== "false";
}
