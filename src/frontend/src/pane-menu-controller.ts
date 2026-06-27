import { clampFloatingPoint } from "./floating-position";
import { isHerdrPaneResizeAction } from "./herdr-backend";
import type { TerminalPane, TerminalTab } from "./types";

type PaneMenuControllerOptions = {
  menu: HTMLElement;
  prepareOverlay: () => void;
  isMobileOverlayMode: () => boolean;
  updateIcons: () => void;
  findPaneById: (paneId: string) => TerminalPane | undefined;
  tabForPane: (pane: TerminalPane) => TerminalTab | undefined;
  visiblePaneCount: (tab: TerminalTab) => number;
};

export function createPaneMenuController(options: PaneMenuControllerOptions) {
  let contextPaneId: string | undefined;

  function updateForPane(paneId: string) {
    const pane = options.findPaneById(paneId);
    const tab = pane ? options.tabForPane(pane) : undefined;
    options.menu.querySelectorAll<HTMLButtonElement>("[data-pane-action]").forEach((button) => {
      button.hidden = !paneMenuActionSupported(button.dataset.paneAction ?? "", pane, tab, options.visiblePaneCount);
    });
  }

  return {
    open(clientX: number, clientY: number, paneId: string) {
      options.prepareOverlay();
      contextPaneId = paneId;
      updateForPane(paneId);
      options.menu.hidden = false;
      options.menu.style.left = "0";
      options.menu.style.top = "0";
      options.updateIcons();
      requestAnimationFrame(() => {
        const margin = options.isMobileOverlayMode() ? 10 : 8;
        const rect = options.menu.getBoundingClientRect();
        const point = clampFloatingPoint(clientX, clientY, {
          width: rect.width,
          height: rect.height,
          margin,
        });
        options.menu.style.left = `${point.x}px`;
        options.menu.style.top = `${point.y}px`;
      });
    },
    openForPane(pane: TerminalPane) {
      const rect = pane.mount.getBoundingClientRect();
      this.open(
        rect.left + rect.width / 2,
        Math.min(rect.bottom - 12, window.innerHeight - 12),
        pane.id,
      );
    },
    close() {
      options.menu.hidden = true;
      options.menu.style.left = "";
      options.menu.style.top = "";
      contextPaneId = undefined;
    },
    targetPane(fallback: TerminalPane | undefined): TerminalPane | undefined {
      return contextPaneId ? options.findPaneById(contextPaneId) : fallback;
    },
  };
}

function paneMenuActionSupported(
  action: string,
  pane: TerminalPane | undefined,
  tab: TerminalTab | undefined,
  visiblePaneCount: (tab: TerminalTab) => number,
): boolean {
  if (!pane) return false;
  if (tabHasBackend(tab, "herdr")) {
    return action === "split-right"
      || action === "split-down"
      || isHerdrPaneResizeAction(action)
      || action === "copy-selection"
      || action === "paste-clipboard"
      || action === "close-active-session";
  }
  if (pane.sessionBackend === "zellij") {
    return action === "split-right"
      || action === "split-down"
      || action === "copy-selection"
      || action === "paste-clipboard"
      || action === "close-active-session";
  }
  if (action === "promote-session-to-tab") {
    return Boolean(tab && visiblePaneCount(tab) > 1);
  }
  return action === "split-up"
    || action === "split-down"
    || action === "split-left"
    || action === "split-right"
    || action === "copy-selection"
    || action === "paste-clipboard"
    || action === "close-active-session";
}

function tabHasBackend(tab: TerminalTab | undefined, backend: TerminalPane["sessionBackend"]): boolean {
  return Boolean(tab?.panes.some((pane) => pane.sessionBackend === backend));
}
