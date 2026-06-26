import type { MessageKey } from "../../i18n";
import { escapeAttr, escapeHtml } from "../../utils";
import { DEFAULT_SOUND_PACKAGE_URL, SUPPORTED_SOUND_FORMATS } from "./api";
import type { WhiteNoiseViewState } from "./controller";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type WhiteNoiseToolViewState = WhiteNoiseViewState & {
  disabled: boolean;
  tr: Translate;
};

export function renderWhiteNoiseToolView(state: WhiteNoiseToolViewState): string {
  const disabled = state.disabled || state.loading ? "disabled" : "";
  const playLabel = state.playing ? state.tr("action.whiteNoisePause") : state.tr("action.whiteNoisePlay");
  const playIcon = state.playing ? "pause" : "play";
  return `
    <div class="plugin-tool white-noise-tool" data-white-noise-state="${state.playing ? "playing" : "idle"}">
      <div class="plugin-tool-head white-noise-head">
        <div class="white-noise-title">
          <div class="settings-group-title">${escapeHtml(state.tr("plugin.whiteNoise.name"))}</div>
          <p class="settings-help">${escapeHtml(state.tr("plugin.whiteNoise.help"))}</p>
        </div>
        <div class="white-noise-head-actions">
          <span class="white-noise-state-pill">${escapeHtml(state.tr(state.playing ? "whiteNoise.playing" : "whiteNoise.idle"))}</span>
          <button class="icon-button white-noise-help-button" type="button" data-white-noise-help aria-expanded="${state.helpOpen}" aria-label="${escapeAttr(state.tr("action.whiteNoiseHelp"))}" title="${escapeAttr(state.tr("action.whiteNoiseHelp"))}">
            <i data-lucide="circle-help"></i>
          </button>
          <button class="icon-button" type="button" data-white-noise-action="refresh" aria-label="${escapeAttr(state.tr("action.refresh"))}" title="${escapeAttr(state.tr("action.refresh"))}" ${state.loading ? "disabled" : ""}>
            <i data-lucide="refresh-cw"></i>
          </button>
        </div>
      </div>
      <div class="white-noise-package-row">
        <span>${escapeHtml(state.tr("whiteNoise.helpRemotePackage"))}</span>
        <code>${escapeHtml(DEFAULT_SOUND_PACKAGE_URL)}</code>
      </div>
      ${state.helpOpen ? renderHelpPanel(state) : ""}
      ${renderBody(state, disabled, playLabel, playIcon)}
    </div>
  `;
}

function renderBody(
  state: WhiteNoiseToolViewState,
  disabled: string,
  playLabel: string,
  playIcon: string,
): string {
  if (state.loading && !state.tracks.length) {
    return `<div class="white-noise-empty" role="status">${escapeHtml(state.tr("whiteNoise.loading"))}</div>`;
  }
  if (state.error) {
    return `
      <div class="white-noise-empty" role="status" data-tone="error">
        <strong>${escapeHtml(state.tr("whiteNoise.loadError"))}</strong>
        <span>${escapeHtml(state.error)}</span>
      </div>
    `;
  }
  if (!state.tracks.length) {
    return `
      <div class="white-noise-empty" role="status">
        <strong>${escapeHtml(state.tr(state.catalog.exists ? "whiteNoise.noFiles" : "whiteNoise.dirMissing"))}</strong>
        <span>${escapeHtml(state.tr("whiteNoise.openHelp"))}</span>
        <code>${escapeHtml(DEFAULT_SOUND_PACKAGE_URL)}</code>
      </div>
    `;
  }
  return `
    <div class="white-noise-master">
      <button class="command-button primary white-noise-play" type="button" data-white-noise-action="toggle" aria-label="${escapeAttr(playLabel)}" title="${escapeAttr(playLabel)}" ${disabled}>
        <i data-lucide="${escapeAttr(playIcon)}"></i>
        <span>${escapeHtml(playLabel)}</span>
      </button>
      <button class="command-button white-noise-stop" type="button" data-white-noise-action="stop" aria-label="${escapeAttr(state.tr("action.whiteNoiseStop"))}" title="${escapeAttr(state.tr("action.whiteNoiseStop"))}" ${disabled}>
        <i data-lucide="square"></i>
      </button>
      <label class="white-noise-volume">
        <span>${escapeHtml(state.tr("whiteNoise.masterVolume"))}</span>
        <input type="range" min="0" max="100" step="1" data-white-noise-master-volume value="${escapeAttr(percent(state.masterVolume))}" ${disabled} />
        <em>${escapeHtml(percent(state.masterVolume))}%</em>
      </label>
    </div>
    ${renderTrackGroups(state)}
  `;
}

function renderHelpPanel(state: WhiteNoiseToolViewState): string {
  const formats = SUPPORTED_SOUND_FORMATS.join(", ");
  const rootPath = state.catalog.rootPath || "/lzcapp/var/sounds";
  const tree = [
    "sounds/",
    "  rain/",
    "    light-rain.mp3",
    "  noise/",
    "    white-noise.wav",
    "  custom/",
    "    my-focus-sound.ogg",
  ].join("\n");
  return `
    <section class="white-noise-help-panel" aria-label="${escapeAttr(state.tr("whiteNoise.helpTitle"))}">
      <div>
        <strong>${escapeHtml(state.tr("whiteNoise.helpTitle"))}</strong>
        <p>${escapeHtml(state.tr("whiteNoise.helpRoot", { path: rootPath }))}</p>
      </div>
      <div class="white-noise-help-command">
        <span>${escapeHtml(state.tr("whiteNoise.helpRemotePackage"))}</span>
        <code>${escapeHtml(DEFAULT_SOUND_PACKAGE_URL)}</code>
      </div>
      <div>
        <span>${escapeHtml(state.tr("whiteNoise.helpZipTitle"))}</span>
        <pre><code>${escapeHtml(tree)}</code></pre>
      </div>
      <div class="white-noise-help-command">
        <span>${escapeHtml(state.tr("whiteNoise.helpUnzip"))}</span>
        <code>curl -L -o /tmp/sounds.zip ${escapeHtml(DEFAULT_SOUND_PACKAGE_URL)} && unzip -o /tmp/sounds.zip -d /lzcapp/var</code>
      </div>
      <p>${escapeHtml(state.tr("whiteNoise.helpFormats", { formats }))}</p>
      <p>${escapeHtml(state.tr("whiteNoise.helpCustom"))}</p>
    </section>
  `;
}

function renderTrackGroups(state: WhiteNoiseToolViewState): string {
  const categories = Array.from(new Set(state.tracks.map((item) => item.track.category)));
  return `
    <div class="white-noise-track-list" role="list" aria-label="${escapeAttr(state.tr("whiteNoise.soundMix"))}">
      ${categories.map((category) => `
        <section class="white-noise-category">
          <div class="white-noise-category-title">
            <span>${escapeHtml(category)}</span>
            <em>${escapeHtml(state.tr("whiteNoise.categoryCount", {
              count: state.tracks.filter((item) => item.track.category === category).length,
            }))}</em>
          </div>
          ${state.tracks.filter((item) => item.track.category === category).map((item) => renderTrack(item, state)).join("")}
        </section>
      `).join("")}
    </div>
  `;
}

function renderTrack(
  item: WhiteNoiseViewState["tracks"][number],
  state: WhiteNoiseToolViewState,
): string {
  const disabled = state.disabled ? "disabled" : "";
  const toggleLabel = state.tr("whiteNoise.toggleTrack", { name: item.track.name });
  return `
    <article class="white-noise-track" role="listitem" data-white-noise-enabled="${item.enabled}">
      <button class="white-noise-track-toggle" type="button" data-white-noise-track-toggle="${escapeAttr(item.track.id)}" aria-pressed="${item.enabled}" aria-label="${escapeAttr(toggleLabel)}" title="${escapeAttr(toggleLabel)}" ${disabled}>
        <i data-lucide="${escapeAttr(soundIcon(item.track.category))}"></i>
      </button>
      <div class="white-noise-track-main">
        <div class="white-noise-track-title">
          <strong>${escapeHtml(item.track.name)}</strong>
          <span>${escapeHtml(state.tr(item.enabled ? "whiteNoise.enabled" : "whiteNoise.disabled"))}</span>
        </div>
        <small>${escapeHtml(item.track.path)}</small>
        <label class="white-noise-track-volume">
          <span class="sr-only">${escapeHtml(state.tr("whiteNoise.trackVolume", { name: item.track.name }))}</span>
          <input type="range" min="0" max="100" step="1" data-white-noise-track-volume="${escapeAttr(item.track.id)}" value="${escapeAttr(percent(item.volume))}" ${disabled || !item.enabled ? "disabled" : ""} />
          <em>${escapeHtml(percent(item.volume))}%</em>
        </label>
      </div>
    </article>
  `;
}

function soundIcon(category: string): string {
  const normalized = category.toLowerCase();
  if (normalized.includes("rain") || normalized.includes("water")) return "cloud-rain";
  if (normalized.includes("wind")) return "wind";
  if (normalized.includes("fire")) return "flame";
  if (normalized.includes("noise")) return "radio";
  if (normalized.includes("music")) return "music";
  return "waves";
}

function percent(value: number): string {
  return String(Math.round(value * 100));
}
