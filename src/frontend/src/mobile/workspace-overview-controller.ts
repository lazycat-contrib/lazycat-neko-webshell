import type { MessageKey } from "../i18n.ts";
import { renderMobileWorkspaceOverview } from "./workspace-overview-view.ts";
import type { MobileWorkspaceOverviewTab } from "./workspace-overview-types.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type Options = {
  root: HTMLElement;
  items: () => MobileWorkspaceOverviewTab[];
  activate: (tabId: string, paneId: string) => void;
  prepare: () => void;
  restoreFallback: () => void;
  updateIcons: () => void;
  tr: Translate;
};

export function createMobileWorkspaceOverviewController(options: Options) {
  const sheet = options.root.querySelector<HTMLElement>(".mobile-workspace-overview-sheet");
  const list = options.root.querySelector<HTMLElement>("[data-mobile-overview-list]");
  let restoreFocus: HTMLElement | null = null;
  let closeTimer: number | undefined;

  function render() {
    if (!list) return;
    list.innerHTML = renderMobileWorkspaceOverview(options.items(), {
      empty: options.tr("status.workspaceOverviewEmpty"),
      active: options.tr("status.active"),
    });
    options.updateIcons();
  }

  function open() {
    window.clearTimeout(closeTimer);
    restoreFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    options.prepare();
    render();
    options.root.hidden = false;
    options.root.dataset.state = "opening";
    requestAnimationFrame(() => {
      options.root.dataset.state = "open";
      sheet?.focus({ preventScroll: true });
    });
  }

  function close() {
    if (options.root.hidden) return;
    window.clearTimeout(closeTimer);
    options.root.dataset.state = "closing";
    closeTimer = window.setTimeout(() => {
      options.root.hidden = true;
      delete options.root.dataset.state;
      if (restoreFocus?.isConnected) restoreFocus.focus({ preventScroll: true });
      else options.restoreFallback();
      restoreFocus = null;
    }, 150);
  }

  function bind() {
    options.root.addEventListener("click", (event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-mobile-overview-close]")) return close();
      const pane = target?.closest<HTMLButtonElement>("[data-mobile-overview-pane]");
      if (!pane) return;
      options.activate(pane.dataset.mobileOverviewTab ?? "", pane.dataset.mobileOverviewPane ?? "");
      close();
    });
    options.root.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = sheet
        ? [sheet, ...Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]'))]
        : [];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
  }

  return { bind, open, close, render, isOpen: () => !options.root.hidden };
}
