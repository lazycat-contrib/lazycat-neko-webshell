import type { SessionBackendId, Tone } from "./types";
import { escapeAttr, escapeHtml } from "./utils.ts";

export type NewTabMenuItem = {
  id: SessionBackendId;
  label: string;
  selected: boolean;
};

export type TabViewItem = {
  id: string;
  active: boolean;
  renaming: boolean;
  named: boolean;
  pinned: boolean;
  pinnedGlyph: string;
  canMovePinnedPrevious: boolean;
  canMovePinnedNext: boolean;
  displayName: string;
  title: string;
  tone: Tone;
  icon?: string;
  iconOnly?: boolean;
};

export type TabViewLabels = {
  empty: string;
  rename: string;
  close: string;
  pin: string;
  unpin: string;
  movePinnedPrevious: string;
  movePinnedNext: string;
};

export type SyncTabsViewResult = {
  rendered: boolean;
  renameInputs: HTMLInputElement[];
};

export function renderNewTabMenuView(items: NewTabMenuItem[], defaultLabel: string): string {
  return items.map((item) => `
    <button type="button" role="menuitem" data-new-tab-backend="${escapeAttr(item.id)}" data-default-backend="${item.selected}">
      <i data-lucide="${escapeAttr(backendIcon(item.id))}"></i>
      <span>${escapeHtml(item.label)}</span>
      ${item.selected ? `<small>${escapeHtml(defaultLabel)}</small>` : ""}
    </button>
  `).join("");
}

export function renderTabsView(items: TabViewItem[], labels: TabViewLabels): string {
  if (!items.length) {
    return `<div class="empty-tab">${escapeHtml(labels.empty)}</div>`;
  }
  return items.map((tab) => renderTabView(tab, labels)).join("");
}

export function syncTabsView(container: HTMLElement, items: TabViewItem[], labels: TabViewLabels): SyncTabsViewResult {
  const labelsSignature = tabLabelsSignature(labels);
  if (shouldRenderTabs(container, items, labelsSignature)) {
    container.innerHTML = renderTabsView(items, labels);
    container.dataset.tabLabelsSignature = labelsSignature;
    return {
      rendered: true,
      renameInputs: Array.from(container.querySelectorAll<HTMLInputElement>(".tab-rename[data-rename-tab]")),
    };
  }

  container.dataset.tabLabelsSignature = labelsSignature;
  if (!items.length) return { rendered: false, renameInputs: [] };

  const elements = tabElements(container);
  items.forEach((item, index) => patchTabElement(elements[index], item, labels));
  return { rendered: false, renameInputs: [] };
}

function renderTabView(tab: TabViewItem, labels: TabViewLabels): string {
  const icon = tab.icon
    ? `<span class="tab-remote-icon" aria-hidden="true"><i data-lucide="${escapeAttr(tab.icon)}"></i></span>`
    : "";
  const label = tab.renaming
    ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(tab.displayName)}" aria-label="${escapeAttr(labels.rename)}" spellcheck="false" />`
    : tab.iconOnly && tab.icon
      ? icon
      : tab.pinned
      ? `<span class="tab-pin-glyph" aria-hidden="true">${escapeHtml(tab.pinnedGlyph)}</span>`
      : `${icon}<span class="tab-title">${escapeHtml(tab.displayName)}</span>`;
  const pinLabel = tab.pinned ? labels.unpin : labels.pin;
  return `
      <div class="tab ${tab.active ? "active" : ""} ${tab.named ? "named" : ""} ${tab.pinned ? "pinned" : ""} ${tab.iconOnly ? "icon-only" : ""}" data-tab-view-id="${escapeAttr(tab.id)}" data-tab-structure="${escapeAttr(tabStructureSignature(tab))}">
        <div class="tab-main" id="tab-${escapeAttr(tab.id)}" role="tab" tabindex="0" aria-selected="${tab.active}" aria-label="${escapeAttr(tab.title)}" data-tab-id="${escapeAttr(tab.id)}" title="${escapeAttr(tab.title)}">
          <span class="tab-status" data-tone="${tab.tone}"></span>
          ${label}
        </div>
        <div class="tab-pin-actions" aria-label="${escapeAttr(pinLabel)}">
          ${tab.pinned ? `
            <button class="tab-pin-move" data-move-pinned-tab="${escapeAttr(tab.id)}" data-direction="-1" type="button" aria-label="${escapeAttr(labels.movePinnedPrevious)}" title="${escapeAttr(labels.movePinnedPrevious)}" ${tab.canMovePinnedPrevious ? "" : "disabled"}>
              <i data-lucide="chevron-left"></i>
            </button>
            <button class="tab-pin-move" data-move-pinned-tab="${escapeAttr(tab.id)}" data-direction="1" type="button" aria-label="${escapeAttr(labels.movePinnedNext)}" title="${escapeAttr(labels.movePinnedNext)}" ${tab.canMovePinnedNext ? "" : "disabled"}>
              <i data-lucide="chevron-right"></i>
            </button>
          ` : ""}
          <button class="tab-pin-toggle" data-pin-tab="${escapeAttr(tab.id)}" type="button" aria-label="${escapeAttr(pinLabel)}" title="${escapeAttr(pinLabel)}" aria-pressed="${tab.pinned}">
            <i data-lucide="${tab.pinned ? "pin-off" : "pin"}"></i>
          </button>
        </div>
        <button class="tab-close" data-close-tab="${escapeAttr(tab.id)}" type="button" aria-label="${escapeAttr(labels.close)}" title="${escapeAttr(labels.close)}">
          <i data-lucide="x"></i>
        </button>
      </div>
    `;
}

function shouldRenderTabs(container: HTMLElement, items: TabViewItem[], labelsSignature: string): boolean {
  if (container.dataset.tabLabelsSignature !== labelsSignature) return true;
  if (!items.length) return !container.querySelector(":scope > .empty-tab");

  const elements = tabElements(container);
  if (elements.length !== items.length) return true;
  return items.some((item, index) => {
    const element = elements[index];
    return element.dataset.tabViewId !== item.id
      || element.dataset.tabStructure !== tabStructureSignature(item);
  });
}

function patchTabElement(element: HTMLElement | undefined, tab: TabViewItem, labels: TabViewLabels) {
  if (!element) return;
  element.classList.toggle("active", tab.active);
  element.classList.toggle("named", tab.named);
  element.classList.toggle("pinned", tab.pinned);
  element.classList.toggle("icon-only", tab.iconOnly === true);
  element.dataset.tabViewId = tab.id;
  element.dataset.tabStructure = tabStructureSignature(tab);

  const main = element.querySelector<HTMLElement>(".tab-main[data-tab-id]");
  if (main) {
    setAttribute(main, "id", `tab-${tab.id}`);
    setAttribute(main, "aria-selected", String(tab.active));
    setAttribute(main, "aria-label", tab.title);
    setAttribute(main, "title", tab.title);
    main.dataset.tabId = tab.id;
  }

  const status = element.querySelector<HTMLElement>(".tab-status");
  if (status) status.dataset.tone = tab.tone;

  const title = element.querySelector<HTMLElement>(".tab-title");
  if (title && title.textContent !== tab.displayName) title.textContent = tab.displayName;

  const glyph = element.querySelector<HTMLElement>(".tab-pin-glyph");
  if (glyph && glyph.textContent !== tab.pinnedGlyph) glyph.textContent = tab.pinnedGlyph;

  const icon = element.querySelector<HTMLElement>(".tab-remote-icon [data-lucide]");
  if (icon && tab.icon) setAttribute(icon, "data-lucide", tab.icon);

  const rename = element.querySelector<HTMLInputElement>(".tab-rename[data-rename-tab]");
  if (rename) {
    rename.dataset.renameTab = tab.id;
    setAttribute(rename, "aria-label", labels.rename);
    if (document.activeElement !== rename && rename.value !== tab.displayName) {
      rename.value = tab.displayName;
    }
  }

  const pinLabel = tab.pinned ? labels.unpin : labels.pin;
  const pinActions = element.querySelector<HTMLElement>(".tab-pin-actions");
  if (pinActions) setAttribute(pinActions, "aria-label", pinLabel);

  const pinToggle = element.querySelector<HTMLButtonElement>(".tab-pin-toggle[data-pin-tab]");
  if (pinToggle) {
    pinToggle.dataset.pinTab = tab.id;
    setAttribute(pinToggle, "aria-label", pinLabel);
    setAttribute(pinToggle, "title", pinLabel);
    setAttribute(pinToggle, "aria-pressed", String(tab.pinned));
  }

  const previousMove = element.querySelector<HTMLButtonElement>('.tab-pin-move[data-direction="-1"]');
  patchPinnedMoveButton(previousMove, tab.id, tab.canMovePinnedPrevious, labels.movePinnedPrevious);

  const nextMove = element.querySelector<HTMLButtonElement>('.tab-pin-move[data-direction="1"]');
  patchPinnedMoveButton(nextMove, tab.id, tab.canMovePinnedNext, labels.movePinnedNext);

  const close = element.querySelector<HTMLButtonElement>(".tab-close[data-close-tab]");
  if (close) {
    close.dataset.closeTab = tab.id;
    setAttribute(close, "aria-label", labels.close);
    setAttribute(close, "title", labels.close);
  }
}

function patchPinnedMoveButton(button: HTMLButtonElement | null, tabId: string, enabled: boolean, label: string) {
  if (!button) return;
  button.dataset.movePinnedTab = tabId;
  button.disabled = !enabled;
  setAttribute(button, "aria-label", label);
  setAttribute(button, "title", label);
}

function setAttribute(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) {
    element.setAttribute(name, value);
  }
}

function tabElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(":scope > .tab[data-tab-view-id]"));
}

function tabStructureSignature(tab: TabViewItem): string {
  if (tab.renaming) return "rename";
  if (tab.iconOnly && tab.icon) return `icon-only:${tab.icon}`;
  if (tab.pinned) return "pinned";
  if (tab.icon) return `icon-title:${tab.icon}`;
  return "normal";
}

function tabLabelsSignature(labels: TabViewLabels): string {
  return JSON.stringify([
    labels.empty,
    labels.rename,
    labels.close,
    labels.pin,
    labels.unpin,
    labels.movePinnedPrevious,
    labels.movePinnedNext,
  ]);
}

function backendIcon(id: SessionBackendId): string {
  if (id === "herdr") return "panels-top-left";
  if (id === "zellij") return "layout-dashboard";
  if (id === "ssh") return "key-round";
  return "terminal";
}
