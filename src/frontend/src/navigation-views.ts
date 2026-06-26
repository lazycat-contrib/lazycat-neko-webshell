import type { SessionBackendId, Tone } from "./types";
import { escapeAttr, escapeHtml } from "./utils";

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

export function renderTabsView(items: TabViewItem[], labels: {
  empty: string;
  rename: string;
  close: string;
  pin: string;
  unpin: string;
  movePinnedPrevious: string;
  movePinnedNext: string;
}): string {
  if (!items.length) {
    return `<div class="empty-tab">${escapeHtml(labels.empty)}</div>`;
  }
  return items.map((tab) => {
    const label = tab.renaming
      ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(tab.displayName)}" aria-label="${escapeAttr(labels.rename)}" spellcheck="false" />`
      : tab.pinned
        ? `<span class="tab-pin-glyph" aria-hidden="true">${escapeHtml(tab.pinnedGlyph)}</span>`
        : `<span class="tab-title">${escapeHtml(tab.displayName)}</span>`;
    const pinLabel = tab.pinned ? labels.unpin : labels.pin;
    return `
      <div class="tab ${tab.active ? "active" : ""} ${tab.named ? "named" : ""} ${tab.pinned ? "pinned" : ""}">
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
  }).join("");
}

function backendIcon(id: SessionBackendId): string {
  if (id === "herdr") return "panels-top-left";
  if (id === "zellij") return "layout-dashboard";
  if (id === "ssh") return "key-round";
  return "terminal";
}
