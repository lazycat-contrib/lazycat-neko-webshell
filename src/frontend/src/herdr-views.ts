import type { HerdrTabInfo, HerdrWorkspaceInfo } from "./types";
import { escapeAttr, escapeHtml } from "./utils";

export function renderHerdrWorkspaceMenuRow(
  workspace: HerdrWorkspaceInfo,
  labels: { tabs: string; panes: string; close: string },
): string {
  const label = workspace.label.trim() || `Workspace ${workspace.number || ""}`.trim();
  const detail = `${workspace.tab_count} ${labels.tabs} · ${workspace.pane_count} ${labels.panes}`;
  return `
    <div class="herdr-workspace-row-shell ${workspace.focused ? "selected" : ""}" role="option" aria-selected="${workspace.focused}">
      <button class="herdr-workspace-row" type="button" data-herdr-workspace="${escapeAttr(workspace.workspace_id)}">
        <span>
          <strong>${escapeHtml(label)}</strong>
          <small>${escapeHtml(detail)}</small>
        </span>
        ${workspace.focused ? `<i data-lucide="check"></i>` : ""}
      </button>
      <button class="herdr-workspace-close" type="button" data-herdr-close-workspace="${escapeAttr(workspace.workspace_id)}" aria-label="${escapeAttr(labels.close)}" title="${escapeAttr(labels.close)}">
        <i data-lucide="x"></i>
      </button>
    </div>
  `;
}

export function renderHerdrWorkspaceMenuView(
  workspaces: HerdrWorkspaceInfo[],
  labels: { tabs: string; panes: string; close: string },
  emptyMessage: string,
): string {
  if (!workspaces.length) {
    return `<div class="empty">${escapeHtml(emptyMessage)}</div>`;
  }
  return workspaces.map((workspace) => renderHerdrWorkspaceMenuRow(workspace, labels)).join("");
}

export function renderHerdrWorkspaceButton(workspace: HerdrWorkspaceInfo, closeLabel: string): string {
  const label = workspace.label.trim() || `Workspace ${workspace.number || ""}`.trim();
  const details = `${workspace.tab_count} tabs, ${workspace.pane_count} panes`;
  const number = String(workspace.number || "").trim();
  return `
    <div class="herdr-space" role="option" aria-selected="${workspace.focused}" title="${escapeAttr(`${label} · ${details}`)}">
      <button class="herdr-chip" type="button" data-herdr-workspace="${escapeAttr(workspace.workspace_id)}">
        ${number ? `<small>${escapeHtml(number)}</small>` : ""}
        <span>${escapeHtml(label)}</span>
      </button>
      <button class="herdr-space-close" type="button" data-herdr-close-workspace="${escapeAttr(workspace.workspace_id)}" aria-label="${escapeAttr(closeLabel)}" title="${escapeAttr(closeLabel)}">
        <i data-lucide="x"></i>
      </button>
    </div>
  `;
}

export function renderHerdrWorkspaceButtons(
  workspaces: HerdrWorkspaceInfo[] | undefined,
  closeLabel: string,
): string {
  return workspaces?.length
    ? workspaces.map((workspace) => renderHerdrWorkspaceButton(workspace, closeLabel)).join("")
    : "";
}

export function renderHerdrTabButton(tab: HerdrTabInfo): string {
  const number = String(tab.number || "").trim();
  const rawLabel = tab.label.trim() || `Tab ${number}`.trim();
  const label = compactHerdrTabLabel(rawLabel, number);
  return `
    <button class="herdr-tab ${label ? "" : "number-only"}" type="button" role="tab" data-herdr-tab="${escapeAttr(tab.tab_id)}" aria-selected="${tab.focused}" title="${escapeAttr(tab.tab_id)}">
      ${number ? `<small>${escapeHtml(number)}</small>` : ""}
      ${label ? `<span>${escapeHtml(label)}</span>` : ""}
    </button>
  `;
}

export function renderHerdrTabButtons(tabs: HerdrTabInfo[] | undefined): string {
  return tabs?.length ? tabs.map(renderHerdrTabButton).join("") : "";
}

function compactHerdrTabLabel(label: string, number: string): string {
  if (!number) return label;
  if (label === number) return "";
  return label.replace(new RegExp(`^${escapeRegExp(number)}(?:[.\\s:-]+)`), "").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
