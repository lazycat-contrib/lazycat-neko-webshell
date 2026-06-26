import type { MessageKey } from "../../i18n";
import { escapeAttr, escapeHtml } from "../../utils";
import type { WhiteNoiseViewState } from "./controller";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type WhiteNoiseFloatingViewState = {
  visible: boolean;
  disabled: boolean;
  playback: Pick<WhiteNoiseViewState, "floatingCollapsed" | "playing" | "loading" | "tracks" | "masterVolume">;
  tr: Translate;
};

export function renderWhiteNoiseFloatingControls(state: WhiteNoiseFloatingViewState): string {
  if (!state.visible) return "";
  if (state.playback.floatingCollapsed) {
    return `
      <div class="white-noise-floating-dock" data-collapsed="true" role="toolbar" aria-label="${escapeAttr(state.tr("plugin.whiteNoise.name"))}">
        ${floatingToggle("expand", "chevron-right", state.tr("action.whiteNoiseExpand"))}
      </div>
    `;
  }
  const playLabel = state.playback.playing ? state.tr("action.whiteNoisePause") : state.tr("action.whiteNoisePlay");
  const disabled = state.disabled || state.playback.loading || !state.playback.tracks.length ? "disabled" : "";
  return `
    <div class="white-noise-floating-dock" role="toolbar" aria-label="${escapeAttr(state.tr("plugin.whiteNoise.name"))}">
      ${floatingToggle("collapse", "chevron-left", state.tr("action.whiteNoiseCollapse"))}
      <div class="white-noise-floating-controls" role="group" aria-label="${escapeAttr(state.tr("plugin.whiteNoise.name"))}">
        ${floatingButton("toggle", state.playback.playing ? "pause" : "play", playLabel, disabled)}
        ${floatingButton("volume-down", "volume-1", state.tr("action.whiteNoiseVolumeDown"), disabled || state.playback.masterVolume <= 0 ? "disabled" : "")}
        ${floatingButton("volume-up", "volume-2", state.tr("action.whiteNoiseVolumeUp"), disabled || state.playback.masterVolume >= 1 ? "disabled" : "")}
      </div>
    </div>
  `;
}

function floatingToggle(action: string, icon: string, label: string): string {
  return `
    <button class="white-noise-floating-toggle" type="button" data-white-noise-floating-action="${escapeAttr(action)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}">
      <i data-lucide="${escapeAttr(icon)}" aria-hidden="true"></i>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function floatingButton(action: string, icon: string, label: string, disabled: string): string {
  return `
    <button type="button" data-white-noise-floating-action="${escapeAttr(action)}" aria-label="${escapeAttr(label)}" title="${escapeAttr(label)}" ${disabled}>
      <i data-lucide="${escapeAttr(icon)}" aria-hidden="true"></i>
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}
