import type { MessageKey } from "../../i18n";
import type { LightOsForwardInfo } from "../lightos-port-forward/types";
import { escapeAttr, escapeHtml } from "../../utils";
import type { PublicTunnelInfo, TunnelProviderProfileSummary } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type PublicTunnelViewState = {
  disabled: boolean;
  provider: string;
  upstreamUrl: string;
  ngrokProfiles: TunnelProviderProfileSummary[];
  tunnels: PublicTunnelInfo[];
  forwards: LightOsForwardInfo[];
  loading: boolean;
  output: string;
  tr: Translate;
};

export function renderPublicTunnelToolView(state: PublicTunnelViewState): string {
  const disabledAttr = state.disabled || state.loading ? "disabled" : "";
  const configuredNgrokProfiles = state.ngrokProfiles.filter((profile) => profile.enabled && profile.configured);
  return `
    <div class="plugin-tool network-tool">
      <div class="plugin-tool-head">
        <div>
          <div class="settings-group-title">${escapeHtml(state.tr("plugin.publicTunnel.name"))}</div>
          <p class="settings-help">${escapeHtml(state.tr("plugin.publicTunnel.help"))}</p>
        </div>
      </div>
      <div class="network-form-grid">
        <label class="field">
          <span>${escapeHtml(state.tr("field.tunnelProvider"))}</span>
          <select data-public-tunnel-field="provider" ${disabledAttr}>
            <option value="cloudflare-quick" ${state.provider === "cloudflare-quick" ? "selected" : ""}>Cloudflare Quick Tunnel</option>
            ${configuredNgrokProfiles.map((profile) => `
              <option value="ngrok:${escapeAttr(profile.id)}" ${state.provider === `ngrok:${profile.id}` ? "selected" : ""}>ngrok · ${escapeHtml(profile.name)}</option>
            `).join("")}
            ${configuredNgrokProfiles.length ? "" : `<option value="" disabled>${escapeHtml(state.tr("status.noTunnelProfiles"))}</option>`}
          </select>
        </label>
        <label class="field network-field-wide">
          <span>${escapeHtml(state.tr("field.upstreamUrl"))}</span>
          <input data-public-tunnel-field="upstreamUrl" type="url" value="${escapeAttr(state.upstreamUrl)}" autocomplete="off" spellcheck="false" placeholder="http://127.0.0.1:3000/" ${disabledAttr} />
        </label>
        <div class="network-actions">
          <button class="command-button primary" type="button" data-public-tunnel-action="start" ${disabledAttr}>
            <i data-lucide="radio-tower"></i>
            <span>${escapeHtml(state.tr("action.tunnelStart"))}</span>
          </button>
          <button class="command-button" type="button" data-public-tunnel-action="list" ${state.disabled || state.loading ? "disabled" : ""}>
            <i data-lucide="refresh-cw"></i>
            <span>${escapeHtml(state.tr("action.refresh"))}</span>
          </button>
        </div>
      </div>
      ${renderForwardPickerForTunnel(state)}
      ${renderPublicTunnelList(state)}
      ${state.output ? `<pre class="plugin-output network-output">${escapeHtml(state.output)}</pre>` : ""}
    </div>
  `;
}

function renderForwardPickerForTunnel(state: PublicTunnelViewState): string {
  if (!state.forwards.length) return "";
  return `
    <div class="network-forward-picks" aria-label="${escapeAttr(state.tr("plugin.lightosPortForward.name"))}">
      ${state.forwards.map((forward) => `
        <button type="button" class="network-forward-pick" data-public-tunnel-upstream="${escapeAttr(forward.localUrl)}" ${state.disabled ? "disabled" : ""}>
          <i data-lucide="waypoints"></i>
          <span>${escapeHtml(`${forward.remoteHost}:${forward.remotePort}`)}</span>
          <small>${escapeHtml(forward.localUrl)}</small>
        </button>
      `).join("")}
    </div>
  `;
}

function renderPublicTunnelList(state: PublicTunnelViewState): string {
  if (state.loading && !state.tunnels.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.pluginsLoading"))}</div>`;
  }
  if (!state.tunnels.length) {
    return `<div class="network-list empty">${escapeHtml(state.tr("status.noPublicTunnels"))}</div>`;
  }
  return `
    <div class="network-list" role="list">
      ${state.tunnels.map((tunnel) => `
        <article class="network-item" role="listitem">
          <span class="network-item-main">
            <strong>${escapeHtml(tunnel.publicUrl)}</strong>
            <small>${escapeHtml(`${tunnel.provider} -> ${tunnel.upstreamUrl}`)}</small>
          </span>
          <span class="network-badge">${escapeHtml(tunnel.status)}</span>
          <span class="network-item-actions">
            <button class="icon-button" type="button" data-network-copy="${escapeAttr(tunnel.publicUrl)}" aria-label="${escapeAttr(state.tr("action.copyUrl"))}" title="${escapeAttr(state.tr("action.copyUrl"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="copy"></i>
            </button>
            <button class="icon-button" type="button" data-public-tunnel-stop="${escapeAttr(tunnel.id)}" aria-label="${escapeAttr(state.tr("action.tunnelStop"))}" title="${escapeAttr(state.tr("action.tunnelStop"))}" ${state.disabled ? "disabled" : ""}>
              <i data-lucide="x"></i>
            </button>
          </span>
        </article>
      `).join("")}
    </div>
  `;
}
