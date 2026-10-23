import { pluginSettings } from "./plugins/entries.generated";
import type { PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import {
  type AIAccessSettingsViewState,
} from "./plugins/ai-chat/settings-view";
import {
  type PublicTunnelSettingsViewState,
} from "./plugins/public-tunnel/settings-view";
import {
  type TerminalMcpSettingsViewState,
} from "./plugins/terminal-mcp/settings-view";
import {
  type TerminalTransferSettingsViewState,
} from "./plugins/terminal-transfer/settings-view";
import {
  type WhiteNoiseSettingsViewState,
} from "./plugins/white-noise/settings-view";
import {
  pluginDescription,
  pluginDisplayName,
  pluginIcon,
  pluginMetaLabel,
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
  const entry = pluginSettings[plugin.id];
  const settingsTool = entry?.render(plugin, state) ?? "";
  const open = expanded || Boolean(entry?.open(state));
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
