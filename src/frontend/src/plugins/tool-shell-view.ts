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

export function syncPluginToolTabs(
  container: HTMLElement,
  tools: PluginDescriptor[],
  activePluginToolId: string,
  tr: Translate,
): boolean {
  const items = tools.map((plugin) => ({
    id: plugin.id,
    label: pluginDisplayName(plugin, tr),
    icon: pluginIcon(plugin.id),
    active: plugin.id === activePluginToolId,
  }));
  const signature = pluginToolTabsSignature(items);
  if (!items.length) {
    const changed = container.childElementCount > 0 || container.dataset.pluginToolTabsSignature !== signature;
    if (changed) {
      container.innerHTML = "";
      container.dataset.pluginToolTabsSignature = signature;
    }
    return changed;
  }

  if (shouldRenderPluginToolTabs(container, items, signature)) {
    container.innerHTML = renderPluginToolTabs(tools, activePluginToolId, tr);
    container.dataset.pluginToolTabsSignature = signature;
    return true;
  }

  container.dataset.pluginToolTabsSignature = signature;
  const buttons = pluginToolTabButtons(container);
  items.forEach((item, index) => patchPluginToolTabButton(buttons[index], item));
  return false;
}

export function renderPluginToolEmpty(pluginsLoading: boolean, tr: Translate): string {
  return `<div class="empty">${escapeHtml(pluginsLoading ? tr("status.pluginsLoading") : tr("status.noPlugins"))}</div>`;
}

type PluginToolTabItem = {
  id: string;
  label: string;
  icon: string;
  active: boolean;
};

function shouldRenderPluginToolTabs(container: HTMLElement, items: PluginToolTabItem[], signature: string): boolean {
  if (container.dataset.pluginToolTabsSignature !== signature) return true;
  const buttons = pluginToolTabButtons(container);
  if (buttons.length !== items.length) return true;
  return items.some((item, index) => buttons[index]?.dataset.pluginTool !== item.id);
}

function patchPluginToolTabButton(button: HTMLButtonElement | undefined, item: PluginToolTabItem) {
  if (!button) return;
  button.dataset.pluginTool = item.id;
  setAttribute(button, "aria-selected", String(item.active));
  setAttribute(button, "aria-label", item.label);
  setAttribute(button, "title", item.label);

  const tooltip = button.querySelector<HTMLElement>(".tool-tip");
  if (tooltip && tooltip.textContent !== item.label) {
    tooltip.textContent = item.label;
  }
  const icon = button.querySelector<HTMLElement>("[data-lucide]");
  if (icon) icon.dataset.lucide = item.icon;
}

function pluginToolTabButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(":scope > button[data-plugin-tool]"));
}

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function pluginToolTabsSignature(items: PluginToolTabItem[]): string {
  return JSON.stringify(items.map((item) => [item.id, item.label, item.icon]));
}
