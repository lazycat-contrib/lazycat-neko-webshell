import { escapeAttr, escapeHtml } from "../utils.ts";
import type { MobileWorkspaceOverviewLabels, MobileWorkspaceOverviewTab } from "./workspace-overview-types.ts";

export function renderMobileWorkspaceOverviewShell(): string {
  return `
    <div class="mobile-workspace-overview" id="mobileWorkspaceOverview" hidden>
      <button type="button" class="mobile-workspace-overview-backdrop" data-mobile-overview-close tabindex="-1" aria-hidden="true"></button>
      <section class="mobile-workspace-overview-sheet" role="dialog" aria-modal="true" aria-labelledby="mobileWorkspaceOverviewTitle" tabindex="-1">
        <header>
          <div><small data-i18n="section.mobileShortcuts">Mobile</small><h2 id="mobileWorkspaceOverviewTitle" data-i18n="section.workspaceOverview">Tabs and panes</h2></div>
          <button type="button" class="icon-button" data-mobile-overview-close aria-label="Close" title="Close" data-i18n-aria="action.close" data-i18n-title="action.close"><i data-lucide="x"></i></button>
        </header>
        <div class="mobile-workspace-overview-list" data-mobile-overview-list></div>
      </section>
    </div>
  `;
}

export function renderMobileWorkspaceOverview(
  tabs: MobileWorkspaceOverviewTab[],
  labels: MobileWorkspaceOverviewLabels,
): string {
  if (!tabs.length) return `<p class="mobile-workspace-overview-empty">${escapeHtml(labels.empty)}</p>`;
  return tabs.map((tab) => `
    <section class="mobile-overview-tab${tab.active ? " active" : ""}" aria-label="${escapeAttr(tab.label)}">
      <div class="mobile-overview-tab-head">
        <span>${escapeHtml(tab.label)}</span><small>${escapeHtml(tab.detail)}</small>
      </div>
      <div class="mobile-overview-pane-list">
        ${tab.panes.map((pane) => `
          <button type="button" data-mobile-overview-tab="${escapeAttr(tab.id)}" data-mobile-overview-pane="${escapeAttr(pane.id)}"${pane.active ? ' aria-current="page"' : ""}>
            <i data-lucide="${pane.backend === "herdr" ? "boxes" : "square-terminal"}"></i>
            <span><strong>${escapeHtml(pane.label)}</strong><small>${escapeHtml(pane.detail)}</small></span>
            ${pane.active ? `<em>${escapeHtml(labels.active)}</em>` : '<i data-lucide="chevron-right"></i>'}
          </button>
        `).join("")}
      </div>
    </section>
  `).join("");
}
