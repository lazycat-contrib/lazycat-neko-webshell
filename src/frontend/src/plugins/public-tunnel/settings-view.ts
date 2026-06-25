import type { MessageKey } from "../../i18n";
import { escapeAttr, escapeHtml } from "../../utils";
import type { TunnelProviderProfileEditor, TunnelProviderProfileSummary } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type PublicTunnelSettingsViewState = {
  disabled: boolean;
  profiles: TunnelProviderProfileSummary[];
  dialog: TunnelProviderProfileDialogViewState | undefined;
  tr: Translate;
};

export type TunnelProviderProfileDialogViewState = {
  profile: TunnelProviderProfileEditor;
  isNew: boolean;
};

export function renderPublicTunnelSettingsView(
  state: PublicTunnelSettingsViewState & { disabled: boolean; tr: Translate },
): string {
  return `
    <div class="plugin-tool tunnel-settings">
      <div class="settings-group-title">${escapeHtml(state.tr("section.tunnelProviders"))}</div>
      <p class="settings-help">${escapeHtml(state.tr("plugin.publicTunnel.settingsHelp"))}</p>
      <div class="ai-mcp-list tunnel-profile-list" role="list">
        ${state.profiles.length
          ? state.profiles.map((profile) => renderTunnelProfileItem(profile, state)).join("")
          : `<div class="empty">${escapeHtml(state.tr("status.noTunnelProfiles"))}</div>`}
      </div>
      <button class="command-button" type="button" data-tunnel-profile-open="new" ${state.disabled ? "disabled" : ""}>
        <i data-lucide="plus"></i>
        <span>${escapeHtml(state.tr("action.tunnelProfileAdd"))}</span>
      </button>
      ${state.dialog ? renderTunnelProfileDialog(state) : ""}
    </div>
  `;
}

function renderTunnelProfileItem(
  profile: TunnelProviderProfileSummary,
  state: PublicTunnelSettingsViewState & { disabled: boolean; tr: Translate },
): string {
  const status = profile.enabled && profile.configured
    ? state.tr("setting.pluginEnabled")
    : profile.configured
      ? state.tr("setting.pluginDisabled")
      : state.tr("status.notConfigured");
  return `
    <div class="ai-mcp-item tunnel-profile-item" role="listitem">
      <span class="ai-mcp-main">
        <strong>${escapeHtml(profile.name)}</strong>
        <small>${escapeHtml(profile.provider)}</small>
      </span>
      <span class="ai-mcp-transport">${escapeHtml(status)}</span>
      <span class="ai-mcp-actions">
        <button class="icon-button" type="button" data-tunnel-profile-open="${escapeAttr(profile.id)}" aria-label="${escapeAttr(state.tr("action.tunnelProfileEdit"))}" title="${escapeAttr(state.tr("action.tunnelProfileEdit"))}" ${state.disabled ? "disabled" : ""}>
          <i data-lucide="square-pen"></i>
        </button>
        <button class="icon-button" type="button" data-tunnel-profile-remove="${escapeAttr(profile.id)}" aria-label="${escapeAttr(state.tr("action.tunnelProfileRemove"))}" title="${escapeAttr(state.tr("action.tunnelProfileRemove"))}" ${state.disabled ? "disabled" : ""}>
          <i data-lucide="trash-2"></i>
        </button>
      </span>
    </div>
  `;
}

function renderTunnelProfileDialog(
  state: PublicTunnelSettingsViewState & { disabled: boolean; tr: Translate },
): string {
  const dialog = state.dialog;
  if (!dialog) return "";
  const title = dialog.isNew ? state.tr("action.tunnelProfileAdd") : state.tr("action.tunnelProfileEdit");
  return `
    <div class="ai-config-modal-backdrop" data-tunnel-profile-close>
      <section class="ai-config-modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}" data-tunnel-profile-modal>
        <header class="ai-config-modal-head">
          <strong>${escapeHtml(title)}</strong>
          <button class="icon-button" type="button" data-tunnel-profile-close aria-label="${escapeAttr(state.tr("action.close"))}" title="${escapeAttr(state.tr("action.close"))}">
            <i data-lucide="x"></i>
          </button>
        </header>
        <div class="ai-config-modal-body">
          <div class="ai-config-grid">
            <label class="field">
              <span>${escapeHtml(state.tr("field.tunnelProfileName"))}</span>
              <input data-tunnel-profile-field="name" type="text" value="${escapeAttr(dialog.profile.name)}" autocomplete="off" spellcheck="false" />
            </label>
            <label class="field">
              <span>${escapeHtml(state.tr("field.aiProvider"))}</span>
              <input type="text" value="ngrok" disabled />
            </label>
            <label class="field ai-config-full">
              <span>${escapeHtml(state.tr("field.ngrokAuthtoken"))}</span>
              <span class="tunnel-token-input-shell">
                <input data-tunnel-profile-field="authtoken" type="password" value="" autocomplete="off" spellcheck="false" placeholder="${escapeAttr(dialog.isNew ? "" : state.tr("field.secretKeepBlank"))}" />
                ${dialog.isNew ? `
                  <button class="icon-button tunnel-token-toggle" type="button" data-tunnel-token-toggle aria-label="${escapeAttr(state.tr("action.showToken"))}" title="${escapeAttr(state.tr("action.showToken"))}">
                    <i data-lucide="eye"></i>
                  </button>
                ` : ""}
              </span>
            </label>
            <label class="switch ai-config-full">
              <input data-tunnel-profile-field="enabled" type="checkbox" ${dialog.profile.enabled ? "checked" : ""} />
              <span>${escapeHtml(state.tr("setting.pluginEnabled"))}</span>
            </label>
          </div>
        </div>
        <footer class="ai-config-modal-actions">
          ${!dialog.isNew ? `
            <button class="command-button danger" type="button" data-tunnel-profile-remove="${escapeAttr(dialog.profile.id)}">
              <i data-lucide="trash-2"></i>
              <span>${escapeHtml(state.tr("action.tunnelProfileRemove"))}</span>
            </button>
          ` : ""}
          <button class="command-button" type="button" data-tunnel-profile-close>
            <span>${escapeHtml(state.tr("action.cancel"))}</span>
          </button>
          <button class="command-button primary" type="button" data-tunnel-profile-save>
            <i data-lucide="save"></i>
            <span>${escapeHtml(state.tr("action.save"))}</span>
          </button>
        </footer>
      </section>
    </div>
  `;
}
