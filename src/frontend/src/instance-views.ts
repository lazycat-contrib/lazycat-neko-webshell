import type { Instance } from "./gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "./i18n";
import { escapeAttr, escapeHtml } from "./utils";
import { instanceSelector, isRunningInstance } from "./workspace-selection";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderInstanceListView(
  instances: Instance[],
  selectedSelector: string,
  tr: Translate,
): string {
  if (!instances.length) {
    return `<div class="empty">${escapeHtml(tr("status.noInstancesVisible"))}</div>`;
  }

  return instances.map((instance) => {
    const selector = instanceSelector(instance);
    const running = isRunningInstance(instance);
    const active = selector === selectedSelector;
    return `
      <button class="instance-row ${active ? "selected" : ""}" data-selector="${escapeAttr(selector)}" ${running ? "" : "disabled"} type="button">
        <span>
          <strong>${escapeHtml(instance.name || selector)}</strong>
        </span>
        <em class="${running ? "ok" : "muted"}">${escapeHtml(instance.status ?? "unknown")}</em>
      </button>
    `;
  }).join("");
}
