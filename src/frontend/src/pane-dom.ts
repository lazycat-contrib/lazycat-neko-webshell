import type { SplitNode, TerminalPane } from "./types";

type TerminalMountHandlers = {
  onPointerDown: (event: PointerEvent) => void;
  onPointerUp: (event: PointerEvent) => void;
  onPointerCancel: (event: PointerEvent) => void;
  onDoubleClick: (event: MouseEvent) => void;
  onMouseUp: () => void;
  onTouchEnd: () => void;
};

export function createTerminalPaneMount(
  paneId: string,
  ariaLabel: string,
  handlers: TerminalMountHandlers,
): HTMLDivElement {
  const mount = document.createElement("div");
  mount.className = "terminal-mount";
  mount.dataset.paneId = paneId;
  mount.tabIndex = 0;
  mount.setAttribute("role", "group");
  mount.setAttribute("aria-label", ariaLabel);
  mount.addEventListener("pointerdown", handlers.onPointerDown);
  mount.addEventListener("pointerup", handlers.onPointerUp);
  mount.addEventListener("pointercancel", handlers.onPointerCancel);
  mount.addEventListener("dblclick", handlers.onDoubleClick);
  mount.addEventListener("mouseup", handlers.onMouseUp);
  mount.addEventListener("touchend", handlers.onTouchEnd);
  return mount;
}

export function renderPaneSplitNode(
  node: SplitNode,
  paneMounts: Map<string, HTMLElement>,
): HTMLElement {
  if (node.type === "pane") {
    return paneMounts.get(node.paneId) ?? missingPaneElement(node.paneId);
  }

  const container = document.createElement("div");
  container.className = "split-container";
  container.dataset.splitAxis = node.axis;
  container.style.setProperty("--split-count", String(Math.max(1, node.children.length)));
  for (const child of node.children) {
    container.appendChild(renderPaneSplitNode(child, paneMounts));
  }
  return container;
}

export function updatePaneMountActiveState(panes: TerminalPane[], activePaneId: string | undefined) {
  for (const pane of panes) {
    pane.mount.classList.toggle("active-pane", pane.id === activePaneId);
  }
}

function missingPaneElement(paneId: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "terminal-mount missing-pane";
  element.dataset.paneId = paneId;
  return element;
}
