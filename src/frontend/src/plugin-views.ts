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

export function renderPluginSettingsView(state: PluginSettingsViewState): string {
  if (!state.plugins.length) {
    return `<div class="empty">${escapeHtml(state.tr(state.pluginsLoading ? "status.pluginsLoading" : "status.noPlugins"))}</div>`;
  }
  return state.plugins.map((plugin) => renderPluginSetting(plugin, state)).join("");
}

function renderPluginSetting(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  const saving = state.savingPluginIds.has(plugin.id);
  const status = plugin.enabled ? state.tr("setting.pluginEnabled") : state.tr("setting.pluginDisabled");
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
  return `
    <div class="plugin-item" role="listitem">
      <div class="plugin-content">
        <div class="plugin-title-row">
          <span class="plugin-icon"><i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i></span>
          <span class="plugin-name">${escapeHtml(pluginDisplayName(plugin, state.tr))}</span>
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
          ${plugin.enabled ? "checked" : ""}
          ${saving || state.pluginsLoading ? "disabled" : ""}
        />
        <span>${escapeHtml(status)}</span>
      </label>
      ${settingsTool}
    </div>
  `;
}
