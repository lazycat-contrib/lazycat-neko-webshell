import type { Instance } from "./gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "./i18n";
import { groupInstances, instanceRowPresentation, type InstanceGroupId } from "./instance-groups";
import { escapeAttr, escapeHtml } from "./utils";
import { instanceSelector } from "./workspace-selection";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function renderInstanceListView(
  instances: Instance[],
  selectedSelector: string,
  tr: Translate,
): string {
  if (!instances.length) {
    return `<div class="empty">${escapeHtml(tr("status.noInstancesVisible"))}</div>`;
  }

  return groupInstances(instances).map((group) => `
    <section class="instance-group" data-instance-group="${group.id}">
      <div class="instance-group-heading">
        <span>${escapeHtml(tr(groupMessageKey(group.id)))}</span>
        <small>${group.instances.length}</small>
      </div>
      <div class="instance-group-items">
        ${group.instances.map((instance) => renderInstanceRow(instance, selectedSelector)).join("")}
      </div>
    </section>
  `).join("");
}

function renderInstanceRow(instance: Instance, selectedSelector: string): string {
  const selector = instanceSelector(instance);
  const presentation = instanceRowPresentation(instance);
  const active = selector === selectedSelector;
  return `
    <button class="instance-row ${active ? "selected" : ""}" data-selector="${escapeAttr(selector)}" data-instance-kind="${presentation.kind}" ${presentation.running ? "" : "disabled"} type="button">
      <span class="instance-row-copy">
        <strong>${escapeHtml(instance.name || selector)}</strong>
        <small>${escapeHtml(presentation.metadata)}</small>
      </span>
      <em class="${presentation.running ? "ok" : "muted"}">${escapeHtml(instance.status || "unknown")}</em>
    </button>
  `;
}

function groupMessageKey(group: InstanceGroupId): MessageKey {
  if (group === "remote") return "instanceGroup.remote";
  if (group === "ssh") return "instanceGroup.ssh";
  return "instanceGroup.lightos";
}
