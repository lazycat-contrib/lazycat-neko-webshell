import {
  renderHerdrJumpMobileActions,
  renderHerdrJumpMobileBackdrop,
  renderHerdrJumpMobileCloseButton,
  renderHerdrJumpMobileDragRegion,
} from "./mobile/herdr-jump-sheet.ts";

export function renderHerdrJumpShell(): string {
  return `
    <section class="herdr-dock" id="herdrDock" aria-label="Herdr controls" data-i18n-aria="section.herdr" hidden>
      <div class="herdr-workspace-switcher" id="herdrWorkspaceSwitcher">
        <button class="herdr-icon-button herdr-jump-trigger" id="herdrWorkspaceButton" type="button" aria-haspopup="dialog" aria-controls="herdrWorkspaceMenu" aria-expanded="false" aria-label="Jump to" title="Jump to" data-i18n-aria="action.herdrJumpTo" data-i18n-title="action.herdrJumpTo">
          <i data-lucide="folder-tree"></i>
        </button>
        ${renderHerdrJumpMobileBackdrop()}
        <div class="herdr-workspace-menu" id="herdrWorkspaceMenu" role="dialog" aria-label="Jump to" data-i18n-aria="action.herdrJumpTo" hidden>
          ${renderHerdrJumpMobileDragRegion()}
          <div class="herdr-jump-head">
            <strong data-i18n="action.herdrJumpTo">Jump to…</strong>
            <div class="herdr-density-switch" role="group" aria-label="Display density" data-i18n-aria="field.herdrDisplayDensity">
              <button type="button" data-herdr-density="compact" aria-pressed="false" data-i18n="option.compact">Compact</button>
              <button type="button" data-herdr-density="normal" aria-pressed="false" data-i18n="option.normal">Normal</button>
            </div>
            ${renderHerdrJumpMobileCloseButton()}
          </div>
          <div class="herdr-workspace-menu-list" id="herdrWorkspaceMenuList"></div>
          <p class="herdr-workspace-menu-status" id="herdrWorkspaceMenuStatus" aria-live="polite"></p>
          ${renderHerdrJumpMobileActions()}
        </div>
      </div>
      <div class="herdr-current-targets" id="herdrTabList" role="list" aria-label="Herdr panes" data-i18n-aria="section.herdrPanes"></div>
      <div id="herdrWorkspaceList" hidden></div>
      <div class="herdr-dock-actions">
        <button class="herdr-icon-button" id="herdrNewTab" type="button" data-herdr-jump-action="create-tab" aria-label="New Herdr tab" title="New Herdr tab" data-i18n-aria="action.newHerdrTab" data-i18n-title="action.newHerdrTab">
          <i data-lucide="plus"></i>
        </button>
        <div class="herdr-more-shell">
          <button class="herdr-icon-button" id="herdrMoreButton" type="button" aria-haspopup="menu" aria-controls="herdrMoreMenu" aria-expanded="false" aria-label="More" title="More" data-i18n-aria="action.more" data-i18n-title="action.more">
            <i data-lucide="ellipsis"></i>
          </button>
          <div class="herdr-more-menu" id="herdrMoreMenu" role="menu" hidden>
            <button id="herdrNewWorkspace" type="button" role="menuitem" data-herdr-jump-action="create-workspace"><i data-lucide="folder-plus"></i><span data-i18n="action.newHerdrSpace">New Herdr space</span></button>
            <button id="herdrRefresh" type="button" role="menuitem" data-herdr-jump-action="refresh"><i data-lucide="refresh-cw"></i><span data-i18n="action.refreshHerdr">Refresh Herdr</span></button>
            <button class="danger" id="herdrCloseWorkspace" type="button" role="menuitem" data-herdr-jump-action="close-workspace"><i data-lucide="folder-x"></i><span data-i18n="action.closeHerdrSpace">Close Herdr space</span></button>
            <span class="herdr-protocol-notice" id="herdrProtocolNotice" role="img" hidden><i data-lucide="arrow-up"></i></span>
          </div>
        </div>
      </div>
      <p class="herdr-status" id="herdrStatus" aria-live="polite"></p>
    </section>
  `;
}
