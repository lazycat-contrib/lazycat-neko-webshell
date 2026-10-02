import type { PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import {
  renderAIAccessSettingsView,
  type AIAccessSettingsViewState,
} from "./plugins/ai-chat/settings-view";
import {
  renderPublicTunnelSettingsView,
  type PublicTunnelSettingsViewState,
} from "./plugins/public-tunnel/settings-view";
import {
  renderTerminalMcpSettingsView,
  type TerminalMcpSettingsViewState,
} from "./plugins/terminal-mcp/settings-view";
import {
  renderTerminalTransferSettingsView,
  type TerminalTransferSettingsViewState,
} from "./plugins/terminal-transfer/settings-view";
import {
  renderWhiteNoiseSettingsView,
  type WhiteNoiseSettingsViewState,
} from "./plugins/white-noise/settings-view";
import {
  AI_CHAT_PLUGIN_ID,
  pluginDescription,
  pluginDisplayName,
  pluginIcon,
  pluginMetaLabel,
  PUBLIC_TUNNEL_PLUGIN_ID,
  TERMINAL_MCP_PLUGIN_ID,
  TERMINAL_TRANSFER_PLUGIN_ID,
  WHITE_NOISE_PLUGIN_ID,
} from "./plugin-utils";
import type { MessageKey } from "./i18n";
import { escapeAttr, escapeHtml } from "./utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export type PluginSettingsViewState = {
  plugins: PluginDescriptor[];
  pluginsLoading: boolean;
  savingPluginIds: Set<string>;
  aiAccess: AIAccessSettingsViewState;
  publicTunnel: PublicTunnelSettingsViewState;
  terminalMcp: Omit<TerminalMcpSettingsViewState, "enabled" | "disabled" | "tr">;
  terminalTransfer: TerminalTransferSettingsViewState;
  whiteNoise: WhiteNoiseSettingsViewState;
  tr: Translate;
};

export function renderPluginSettingsView(state: PluginSettingsViewState, expanded: ReadonlySet<string> = new Set()): string {
  if (!state.plugins.length) {
    return `<div class="empty">${escapeHtml(state.tr(state.pluginsLoading ? "status.pluginsLoading" : "status.noPlugins"))}</div>`;
  }
  return state.plugins.map((plugin) => renderPluginSetting(plugin, state, expanded.has(plugin.id))).join("");
}

function renderPluginSetting(plugin: PluginDescriptor, state: PluginSettingsViewState, expanded: boolean): string {
  const saving = state.savingPluginIds.has(plugin.id);
  const status = saving ? state.tr("settings.pluginSaving")
    : plugin.enabled ? state.tr("setting.pluginEnabled") : state.tr("setting.pluginDisabled");
  const name = pluginDisplayName(plugin, state.tr);
  const meta = Array.from(new Set([plugin.kind, ...plugin.scopes].filter(Boolean)))
    .map((item) => pluginMetaLabel(item, state.tr));
  const settingsTool = plugin.id === AI_CHAT_PLUGIN_ID
    ? renderAIAccessSettingsView({
      ...state.aiAccess,
      disabled: !plugin.enabled || saving || state.pluginsLoading,
      tr: state.tr,
    })
    : plugin.id === PUBLIC_TUNNEL_PLUGIN_ID
      ? renderPublicTunnelSettingsView({
        ...state.publicTunnel,
        disabled: saving || state.pluginsLoading,
        tr: state.tr,
      })
      : plugin.id === TERMINAL_TRANSFER_PLUGIN_ID
      ? renderTerminalTransferSettingsView({
        ...state.terminalTransfer,
        disabled: saving || state.pluginsLoading,
        tr: state.tr,
      })
      : plugin.id === TERMINAL_MCP_PLUGIN_ID
        ? renderTerminalMcpSettingsView({
          ...state.terminalMcp,
          enabled: plugin.enabled,
          disabled: saving || state.pluginsLoading,
          tr: state.tr,
        })
        : plugin.id === WHITE_NOISE_PLUGIN_ID
          ? renderWhiteNoiseSettingsView({
            ...state.whiteNoise,
            disabled: saving || state.pluginsLoading,
            tr: state.tr,
          })
          : "";
  const open = expanded || Boolean((plugin.id === AI_CHAT_PLUGIN_ID && state.aiAccess.dialog)
    || (plugin.id === PUBLIC_TUNNEL_PLUGIN_ID && state.publicTunnel.dialog));
  return `
    <div class="plugin-item" role="listitem" data-enabled="${plugin.enabled}" aria-busy="${saving}">
      <div class="plugin-content">
        <div class="plugin-title-row">
          <span class="plugin-icon"><i data-lucide="${escapeAttr(pluginIcon(plugin.id))}" aria-hidden="true"></i></span>
          <span class="plugin-name">${escapeHtml(name)}</span>
        </div>
        <p class="plugin-description">${escapeHtml(pluginDescription(plugin, state.tr))}</p>
        <div class="plugin-meta">
          ${meta.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
        </div>
      </div>
      <label class="switch plugin-switch">
        <input
          type="checkbox"
          data-plugin-toggle="${escapeAttr(plugin.id)}"
          aria-label="${escapeAttr(`${name}: ${status}`)}"
          ${plugin.enabled ? "checked" : ""}
          ${saving || state.pluginsLoading ? "disabled" : ""}
        />
        <span>${escapeHtml(status)}</span>
      </label>
      ${settingsTool ? `<details class="plugin-configuration" data-plugin-settings="${escapeAttr(plugin.id)}" ${open ? "open" : ""}>
        <summary role="button" data-plugin-config-toggle="${escapeAttr(plugin.id)}" aria-expanded="${open}" aria-label="${escapeAttr(`${name}: ${state.tr("settings.pluginConfigure")}`)}"><span>${escapeHtml(state.tr("settings.pluginConfigure"))}</span><i data-lucide="chevron-down" aria-hidden="true"></i></summary>
        <div class="plugin-configuration-body">${settingsTool}</div>
      </details>` : ""}
    </div>
  `;
}
