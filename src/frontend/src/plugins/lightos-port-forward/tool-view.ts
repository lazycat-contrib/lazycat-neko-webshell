import type { MessageKey } from "../../i18n";
import { escapeAttr, escapeHtml } from "../../utils";
import type { LightOsForwardInfo } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type LightOsPortForwardViewState = {
  disabled: boolean;
  remoteHost: string;
  remotePort: string;
  forwards: LightOsForwardInfo[];
  loading: boolean;
  output: string;
  tr: Translate;
};

export function renderLightOsPortForwardToolView(state: LightOsPortForwardViewState): string {
  const disabledAttr = state.disabled || state.loading ? "disabled" : "";
  return `
    <div class="plugin-tool network-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(state.tr("plugin.lightosPortForward.name"))}</div>
          <p class="settings-help">${escapeHtml(state.tr("plugin.lightosPortForward.help"))}</p>
        </div>
      </div>
      <div class="network-form-grid">
        <label class="field">
          <span>${escapeHtml(state.tr("field.remoteHost"))}</span>
          <input data-port-forward-field="remoteHost" type="text" value="${escapeAttr(state.remoteHost)}" autocomplete="off" spellcheck="false" ${disabledAttr} />
        </label>
        <label class="field">
          <span>${escapeHtml(state.tr("field.remotePort"))}</span>
          <input data-port-forward-field="remotePort" type="number" min="1" max="65535" inputmode="numeric" value="${escapeAttr(state.remotePort)}" ${disabledAttr} />
        </label>
        <div class="network-actions">
          <button class="command-button primary" type="button" data-port-forward-action="acquire" ${disabledAttr}>
            <i data-lucide="waypoints"></i>
            <span>${escapeHtml(state.tr("action.portForwardAcquire"))}</span>
          </button>
          <button class="command-button" type="button" data-port-forward-action="list" ${state.disabled || state.loading ? "disabled" : ""}>
            <i data-lucide="refresh-cw"></i>
            <span>${escapeHtml(state.tr("action.refresh"))}</span>
          </button>
        </div>
      </div>
      ${renderLightOsForwardList(state)}
      ${state.output ? `<pre class="plugin-output network-output">${escapeHtml(state.output)}</pre>` : ""}
    </div>
  `;
}

function renderLightOsForwardList(state: LightOsPortForwardViewState): string {
  if (state.loading && !state.forwards.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.pluginsLoading"))}</div>`;
  }
  if (!state.forwards.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.noPortForwards"))}</div>`;
  }
  return `
    <div class="network-list" role="list">
      ${state.forwards.map((forward) => `
        <article class="network-item" role="listitem">
          <span class="network-item-main">
            <strong>${escapeHtml(forward.localUrl)}</strong>
            <small>${escapeHtml(`${forward.remoteHost}:${forward.remotePort} -> ${forward.localHost}:${forward.localPort}`)}</small>
          </span>
          <span class="network-badge">${escapeHtml(forward.status)}</span>
          <span class="network-item-actions">
            <button class="icon-button" type="button" data-network-copy="${escapeAttr(forward.localUrl)}" aria-label="${escapeAttr(state.tr("action.copyUrl"))}" title="${escapeAttr(state.tr("action.copyUrl"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button" type="button" data-port-forward-use-tunnel="${escapeAttr(forward.localUrl)}" aria-label="${escapeAttr(state.tr("action.useForTunnel"))}" title="${escapeAttr(state.tr("action.useForTunnel"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="radio-tower"></i>
            </button>
            <button class="icon-button" type="button" data-port-forward-release="${escapeAttr(forward.id)}" aria-label="${escapeAttr(state.tr("action.portForwardRelease"))}" title="${escapeAttr(state.tr("action.portForwardRelease"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="x"></i>
            </button>
          </span>
        </article>
      `).join("")}
    </div>
  `;
}
