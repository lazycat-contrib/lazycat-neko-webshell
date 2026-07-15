import type { HerdrPaneInfo, HerdrTabInfo, HerdrWorkspaceInfo } from "./types";
import { escapeAttr, escapeHtml } from "./utils.ts";

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
    <div class="herdr-space" role="option" aria-selected="${workspace.focused}" title="${escapeAttr(`${label} · ${details}`)}" data-herdr-workspace-item="${escapeAttr(workspace.workspace_id)}">
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

export function herdrPaneDetailForTab(tab: HerdrTabInfo, panes: HerdrPaneInfo[]): string {
  const matching = panes.filter((pane) => pane.tab_id === tab.tab_id);
  const pane = matching.find((item) => item.focused) ?? matching[0];
  return pane?.title?.trim()
    || pane?.terminal_title_stripped?.trim()
    || pane?.display_agent?.trim()
    || pane?.terminal_title?.trim()
    || pane?.agent?.trim()
    || "";
}

export function herdrTabPresentation(
  tab: HerdrTabInfo,
  panes: HerdrPaneInfo[],
): { label: string; title: string } {
  const number = String(tab.number || "").trim();
  const rawLabel = tab.label.trim() || `Tab ${number}`.trim();
  const compactLabel = compactHerdrTabLabel(rawLabel, number);
  const explicitLabel = herdrTabLabelIsGeneric(rawLabel, number) ? "" : compactLabel;
  const detail = herdrPaneDetailForTab(tab, panes);
  const label = explicitLabel || detail;
  const title = uniqueNonEmpty([explicitLabel || rawLabel, detail, tab.tab_id]).join(" · ");
  return { label, title };
}

export function renderHerdrTabButton(tab: HerdrTabInfo, panes: HerdrPaneInfo[] = []): string {
  const number = String(tab.number || "").trim();
  const presentation = herdrTabPresentation(tab, panes);
  return `
    <button class="herdr-tab ${presentation.label ? "" : "number-only"}" type="button" role="tab" data-herdr-tab="${escapeAttr(tab.tab_id)}" aria-selected="${tab.focused}" title="${escapeAttr(presentation.title)}">
      ${number ? `<small>${escapeHtml(number)}</small>` : ""}
      ${presentation.label ? `<span>${escapeHtml(presentation.label)}</span>` : ""}
    </button>
  `;
}

export function renderHerdrTabButtons(
  tabs: HerdrTabInfo[] | undefined,
  panes: HerdrPaneInfo[] = [],
): string {
  return tabs?.length ? tabs.map((tab) => renderHerdrTabButton(tab, panes)).join("") : "";
}

export function syncHerdrWorkspaceButtons(
  container: HTMLElement,
  workspaces: HerdrWorkspaceInfo[] | undefined,
  closeLabel: string,
): boolean {
  const items = workspaceItems(workspaces, closeLabel);
  const signature = JSON.stringify(items.map((item) => [
    item.id,
    item.number,
    item.label,
    item.details,
    item.closeLabel,
  ]));
  if (!items.length) return syncEmpty(container, "herdrWorkspaceSignature", signature);
  if (container.dataset.herdrWorkspaceSignature !== signature || workspaceElements(container).length !== items.length) {
    container.innerHTML = renderHerdrWorkspaceButtons(workspaces, closeLabel);
    container.dataset.herdrWorkspaceSignature = signature;
    return true;
  }

  container.dataset.herdrWorkspaceSignature = signature;
  const elements = workspaceElements(container);
  items.forEach((item, index) => patchWorkspaceElement(elements[index], item));
  return false;
}

export function syncHerdrTabButtons(
  container: HTMLElement,
  tabs: HerdrTabInfo[] | undefined,
  panes: HerdrPaneInfo[] = [],
): boolean {
  const items = tabItems(tabs, panes);
  const signature = JSON.stringify(items.map((item) => [item.id, item.number, item.label, item.title]));
  if (!items.length) return syncEmpty(container, "herdrTabSignature", signature);
  if (container.dataset.herdrTabSignature !== signature || tabElements(container).length !== items.length) {
    container.innerHTML = renderHerdrTabButtons(tabs);
    container.dataset.herdrTabSignature = signature;
    return true;
  }

  container.dataset.herdrTabSignature = signature;
  const elements = tabElements(container);
  items.forEach((item, index) => patchTabElement(elements[index], item));
  return false;
}

function compactHerdrTabLabel(label: string, number: string): string {
  if (!number) return label;
  if (label === number) return "";
  return label.replace(new RegExp(`^${escapeRegExp(number)}(?:[.\\s:-]+)`), "").trim();
}

function herdrTabLabelIsGeneric(label: string, number: string): boolean {
  const normalized = label.trim();
  if (!normalized) return true;
  if (number && normalized === number) return true;
  return Boolean(number && normalized.toLocaleLowerCase() === `tab ${number}`.toLocaleLowerCase());
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

type WorkspaceItem = {
  id: string;
  number: string;
  label: string;
  details: string;
  closeLabel: string;
  focused: boolean;
};

type TabItem = {
  id: string;
  number: string;
  label: string;
  title: string;
  focused: boolean;
};

function workspaceItems(workspaces: HerdrWorkspaceInfo[] | undefined, closeLabel: string): WorkspaceItem[] {
  return workspaces?.map((workspace) => {
    const label = workspace.label.trim() || `Workspace ${workspace.number || ""}`.trim();
    return {
      id: workspace.workspace_id,
      number: String(workspace.number || "").trim(),
      label,
      details: `${workspace.tab_count} tabs, ${workspace.pane_count} panes`,
      closeLabel,
      focused: workspace.focused,
    };
  }) ?? [];
}

function tabItems(tabs: HerdrTabInfo[] | undefined, panes: HerdrPaneInfo[]): TabItem[] {
  return tabs?.map((tab) => {
    const number = String(tab.number || "").trim();
    const presentation = herdrTabPresentation(tab, panes);
    return {
      id: tab.tab_id,
      number,
      label: presentation.label,
      title: presentation.title,
      focused: tab.focused,
    };
  }) ?? [];
}

function patchWorkspaceElement(element: HTMLElement | undefined, item: WorkspaceItem) {
  if (!element) return;
  element.dataset.herdrWorkspaceItem = item.id;
  element.setAttribute("aria-selected", String(item.focused));
  element.setAttribute("title", `${item.label} · ${item.details}`);
  const chip = element.querySelector<HTMLButtonElement>("[data-herdr-workspace]");
  if (chip) chip.dataset.herdrWorkspace = item.id;
  const number = chip?.querySelector<HTMLElement>("small");
  if (number && number.textContent !== item.number) number.textContent = item.number;
  const label = chip?.querySelector<HTMLElement>("span");
  if (label && label.textContent !== item.label) label.textContent = item.label;
  const close = element.querySelector<HTMLButtonElement>("[data-herdr-close-workspace]");
  if (close) {
    close.dataset.herdrCloseWorkspace = item.id;
    close.setAttribute("aria-label", item.closeLabel);
    close.setAttribute("title", item.closeLabel);
  }
}

function patchTabElement(element: HTMLButtonElement | undefined, item: TabItem) {
  if (!element) return;
  element.dataset.herdrTab = item.id;
  element.classList.toggle("number-only", !item.label);
  element.setAttribute("aria-selected", String(item.focused));
  element.setAttribute("title", item.title);
  const number = element.querySelector<HTMLElement>("small");
  if (number && number.textContent !== item.number) number.textContent = item.number;
  const label = element.querySelector<HTMLElement>("span");
  if (label && label.textContent !== item.label) label.textContent = item.label;
}

function workspaceElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .herdr-space[data-herdr-workspace-item]"));
}

function tabElements(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(":scope > .herdr-tab[data-herdr-tab]"));
}

function syncEmpty(container: HTMLElement, signatureKey: string, signature: string): boolean {
  const changed = container.childElementCount > 0 || container.dataset[signatureKey] !== signature;
  if (changed) {
    container.replaceChildren();
    container.dataset[signatureKey] = signature;
  }
  return changed;
}
