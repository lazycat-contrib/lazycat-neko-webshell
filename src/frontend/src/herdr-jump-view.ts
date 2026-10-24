import type { HerdrJumpDensity, HerdrJumpGroup, HerdrJumpModel, HerdrJumpTarget } from "./herdr-jump-model.ts";
import { escapeAttr, escapeHtml } from "./utils.ts";
import type { HerdrActivity } from "./herdr-activity.ts";
import { renderHerdrAgentIcon } from "./herdr-agent-icon-view.ts";

export type HerdrJumpLabels = {
  jumpTo: string;
  compact: string;
  normal: string;
  density: string;
  current: string;
  empty: string;
  focusWorkspace: string;
  focusTab: string;
  focusPane: string;
  activity?: (status: HerdrActivity) => string;
  attention?: string;
};

export function renderHerdrJumpGroups(
  model: HerdrJumpModel,
  density: HerdrJumpDensity,
  labels: HerdrJumpLabels,
): string {
  if (!model.groups.length) return `<div class="herdr-jump-empty empty">${escapeHtml(labels.empty)}</div>`;
  return model.groups.map((group) => renderGroup(group, density, labels)).join("");
}

export function renderHerdrCurrentTargets(
  model: HerdrJumpModel,
  density: HerdrJumpDensity,
  labels: HerdrJumpLabels,
): string {
  const targets = model.currentWorkspace?.targets ?? [];
  return targets.map((target) => renderTarget(target, density, labels)).join("");
}

function renderGroup(group: HerdrJumpGroup, density: HerdrJumpDensity, labels: HerdrJumpLabels): string {
  const workspaceLabel = group.current ? `${group.label} · ${labels.current}` : group.label;
  return `
    <section class="herdr-jump-group" data-current="${group.current}">
      <button class="herdr-jump-workspace" type="button" data-status="${escapeAttr(group.status)}" data-herdr-jump-workspace="${escapeAttr(group.workspaceId)}" aria-label="${escapeAttr(`${labels.focusWorkspace}: ${group.label} · ${activityLabel(group.status, labels)}`)}" title="${escapeAttr(activityLabel(group.status, labels))}">
        <span class="herdr-jump-workspace-number">${escapeHtml(group.number)}</span>
        <strong>${escapeHtml(group.label)}</strong>
        ${group.current ? `<span class="herdr-current-badge">${escapeHtml(labels.current)}</span>` : ""}
      </button>
      <div class="herdr-jump-targets" role="group" aria-label="${escapeAttr(workspaceLabel)}">
        ${group.targets.length
          ? group.targets.map((target) => renderTarget(target, density, labels, true)).join("")
          : `<span class="herdr-jump-group-empty">${escapeHtml(labels.empty)}</span>`}
      </div>
    </section>
  `;
}

function renderTarget(target: HerdrJumpTarget, density: HerdrJumpDensity, labels: HerdrJumpLabels, showAttention = false): string {
  const statusLabel = activityLabel(target.status, labels);
  const accessibleLabel = `${target.paneId ? labels.focusPane : labels.focusTab}: ${target.label} · ${target.sequence} · ${statusLabel}`;
  const targetAttribute = target.paneId
    ? `data-herdr-jump-pane="${escapeAttr(target.paneId)}"`
    : `data-herdr-jump-tab="${escapeAttr(target.tabId)}"`;
  const normalLabel = target.duplicate
    ? `<span class="herdr-target-name">${escapeHtml(target.label)}</span><small class="herdr-target-sequence">${escapeHtml(target.sequence)}</small>`
    : `<span class="herdr-target-name">${escapeHtml(target.label)}</span>`;
  const chip = `
    <button class="herdr-target-chip" type="button" ${targetAttribute} data-status="${escapeAttr(target.status)}" data-current="${target.current}" data-density="${density}" aria-current="${target.current ? "true" : "false"}" aria-label="${escapeAttr(accessibleLabel)}" title="${escapeAttr(`${target.title} · ${statusLabel}`)}">
      ${renderHerdrAgentIcon(target.icon)}
      ${normalLabel}
      ${density === "compact" ? `<span class="herdr-target-compact-sequence">${escapeHtml(target.sequence)}</span>` : ""}
    </button>
  `;
  if (!showAttention || !target.attention) return chip;
  const detail = [labels.attention ?? statusLabel, target.attention.summary].filter(Boolean).join(" · ");
  return `<span class="herdr-attention-target">${chip}
    <button class="herdr-attention-button" type="button" data-herdr-attention="${escapeAttr(target.attention.id)}" aria-haspopup="dialog" aria-label="${escapeAttr(`${target.label}: ${detail}`)}" title="${escapeAttr(detail)}">
      <i data-lucide="message-circle-question" aria-hidden="true"></i>
    </button></span>`;
}

function activityLabel(status: string, labels: HerdrJumpLabels): string {
  return labels.activity?.(status as HerdrActivity) ?? status;
}
