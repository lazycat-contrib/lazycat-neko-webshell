import {
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
        </div>
      </div>
      <div class="herdr-current-targets" id="herdrTabList" role="list" aria-label="Herdr panes" data-i18n-aria="section.herdrPanes"></div>
      <div id="herdrWorkspaceList" hidden></div>
      <div class="herdr-dock-actions">
        <button class="herdr-icon-button" id="herdrNewTab" type="button" data-herdr-jump-action="create-tab" aria-label="New Herdr tab" title="New Herdr tab" data-i18n-aria="action.newHerdrTab" data-i18n-title="action.newHerdrTab">
          <i data-lucide="square-plus"></i>
        </button>
        <button class="herdr-icon-button" id="herdrNewWorkspace" type="button" data-herdr-jump-action="create-workspace" aria-label="New Herdr space" title="New Herdr space" data-i18n-aria="action.newHerdrSpace" data-i18n-title="action.newHerdrSpace">
          <svg data-icon="layers-plus" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 .83.18 2 2 0 0 0 .83-.18l8.58-3.9a1 1 0 0 0 0-1.831z"></path>
            <path d="M16 17h6"></path><path d="M19 14v6"></path>
            <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 .825.178"></path>
            <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l2.116-.962"></path>
          </svg>
        </button>
        <div class="herdr-more-shell">
          <button class="herdr-icon-button" id="herdrMoreButton" type="button" aria-haspopup="menu" aria-controls="herdrMoreMenu" aria-expanded="false" aria-label="More" title="More" data-i18n-aria="action.more" data-i18n-title="action.more">
            <i data-lucide="ellipsis"></i>
          </button>
          <div class="herdr-more-menu" id="herdrMoreMenu" role="menu" hidden>
            <button id="herdrRefresh" type="button" role="menuitem" data-herdr-jump-action="refresh"><i data-lucide="refresh-cw"></i><span data-i18n="action.refreshHerdr">Refresh Herdr</span></button>
            <button class="danger" id="herdrCloseWorkspace" type="button" role="menuitem" data-herdr-jump-action="close-workspace"><i data-lucide="folder-x"></i><span data-i18n="action.closeHerdrSpace">Close Herdr space</span></button>
            <div class="herdr-runtime-guard" id="herdrRuntimeGuard" hidden>
              <p id="herdrRuntimeGuardMessage"></p>
              <button id="herdrHandoff" type="button"><i data-lucide="replace"></i><span data-i18n="action.herdrLiveHandoff">Switch without stopping panes</span></button>
            </div>
            <span class="herdr-protocol-notice" id="herdrProtocolNotice" role="img" hidden><i data-lucide="arrow-up"></i></span>
          </div>
        </div>
      </div>
      <p class="herdr-status" id="herdrStatus" aria-live="polite"></p>
    </section>
  `;
}
