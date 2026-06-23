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

export function renderTabsView(items: TabViewItem[], labels: { empty: string; rename: string; close: string }): string {
  if (!items.length) {
    return `<div class="empty-tab">${escapeHtml(labels.empty)}</div>`;
  }
  return items.map((tab) => {
    const label = tab.renaming
      ? `<input class="tab-rename" data-rename-tab="${escapeAttr(tab.id)}" value="${escapeAttr(tab.displayName)}" aria-label="${escapeAttr(labels.rename)}" spellcheck="false" />`
      : `<span class="tab-title">${escapeHtml(tab.displayName)}</span>`;
    return `
      <div class="tab ${tab.active ? "active" : ""} ${tab.named ? "named" : ""}">
        <div class="tab-main" id="tab-${escapeAttr(tab.id)}" role="tab" tabindex="0" aria-selected="${tab.active}" data-tab-id="${escapeAttr(tab.id)}" title="${escapeAttr(tab.title)}">
          <span class="tab-status" data-tone="${tab.tone}"></span>
          ${label}
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
  return "terminal";
}
