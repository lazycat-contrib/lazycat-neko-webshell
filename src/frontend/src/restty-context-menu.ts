import type { TerminalPane } from "./types";

export type ResttyContextMenuPoint = {
  clientX: number;
  clientY: number;
};

export function openResttyPaneContextMenu(
  pane: TerminalPane,
  point?: ResttyContextMenuPoint,
): boolean {
  const restty = pane.term?.restty;
  const container = restty?.getActivePane()?.container;
  const ownerWindow = container?.ownerDocument.defaultView;
  if (!restty || !container || !ownerWindow) return false;

  const resolvedPoint = point ?? defaultContextMenuPoint(container, ownerWindow);
  const event = new ownerWindow.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: resolvedPoint.clientX,
    clientY: resolvedPoint.clientY,
    view: ownerWindow,
  });
  container.dispatchEvent(event);
  return event.defaultPrevented;
}

export function interceptTerminalContextMenuPointer(
  _pane: TerminalPane,
  event: PointerEvent,
): boolean {
  if (event.pointerType !== "mouse" || event.button !== 2) {
    return false;
  }
  event.stopPropagation();
  return true;
}

export function forwardPaneContextMenuToRestty(
  pane: TerminalPane,
  event: MouseEvent,
  prepareOverlay: () => void,
): boolean {
  const container = pane.term?.restty?.getActivePane()?.container;
  const ownerWindow = container?.ownerDocument.defaultView;
  if (!container || !ownerWindow) {
    return false;
  }
  prepareOverlay();
  if (event.target === container) return false;

  event.preventDefault();
  event.stopPropagation();
  return openResttyPaneContextMenu(pane, {
    clientX: event.clientX,
    clientY: event.clientY,
  });
}

export function hideResttyPaneContextMenus(panes: Iterable<TerminalPane>) {
  for (const pane of panes) {
    pane.term?.restty?.hideContextMenu();
  }
}

function defaultContextMenuPoint(container: HTMLElement, ownerWindow: Window): ResttyContextMenuPoint {
  const rect = container.getBoundingClientRect();
  return {
    clientX: rect.left + rect.width / 2,
    clientY: Math.min(rect.bottom - 12, ownerWindow.innerHeight - 12),
  };
}
