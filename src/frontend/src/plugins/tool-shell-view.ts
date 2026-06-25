import type { PluginDescriptor } from "../gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "../i18n";
import { pluginDisplayName, pluginIcon } from "../plugin-utils";
import { escapeAttr, escapeHtml } from "../utils";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderPluginToolTabs(tools: PluginDescriptor[], activePluginToolId: string, tr: Translate): string {
  return tools.map((plugin) => `
    <button type="button" role="tab" data-plugin-tool="${escapeAttr(plugin.id)}" aria-selected="${plugin.id === activePluginToolId}" aria-label="${escapeAttr(pluginDisplayName(plugin, tr))}" title="${escapeAttr(pluginDisplayName(plugin, tr))}">
      <i data-lucide="${escapeAttr(pluginIcon(plugin.id))}"></i>
      <span class="tool-tip">${escapeHtml(pluginDisplayName(plugin, tr))}</span>
    </button>
  `).join("");
}

export function renderPluginToolEmpty(pluginsLoading: boolean, tr: Translate): string {
  return `<div class="empty">${escapeHtml(pluginsLoading ? tr("status.pluginsLoading") : tr("status.noPlugins"))}</div>`;
}
