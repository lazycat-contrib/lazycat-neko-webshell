import type { SplitAxis, SplitNode, SplitPlacement } from "./types";

export function nextPaneLayout(
  layout: SplitNode | undefined,
  referencePaneId: string | undefined,
  newPaneId: string,
  placement: SplitPlacement,
): SplitNode {
  const newPane = paneLayoutNode(newPaneId);
  if (!layout || !referencePaneId) return newPane;

  const axis = splitAxisForPlacement(placement);
  const insertBefore = placement === "up" || placement === "left";
  const result = insertPaneIntoLayout(layout, referencePaneId, newPane, axis, insertBefore);
  if (result.inserted) return result.node;

  return {
    type: "split",
    axis,
    children: insertBefore ? [newPane, layout] : [layout, newPane],
  };
}

export function paneLayoutNode(paneId: string): SplitNode {
  return { type: "pane", paneId };
}

export function removePaneFromLayout(node: SplitNode | undefined, paneId: string): SplitNode | undefined {
  if (!node) return undefined;
  if (node.type === "pane") {
    return node.paneId === paneId ? undefined : node;
  }
  const children = node.children
    .map((child) => removePaneFromLayout(child, paneId))
    .filter((child): child is SplitNode => Boolean(child));
  if (!children.length) return undefined;
  if (children.length === 1) return children[0];
  return { ...node, children };
}

export function paneIdsInLayout(node: SplitNode | undefined): string[] {
  if (!node) return [];
  if (node.type === "pane") return [node.paneId];
  return node.children.flatMap(paneIdsInLayout);
}

function insertPaneIntoLayout(
  node: SplitNode,
  referencePaneId: string,
  newPane: SplitNode,
  axis: SplitAxis,
  insertBefore: boolean,
): { node: SplitNode; inserted: boolean } {
  if (node.type === "pane") {
    if (node.paneId !== referencePaneId) return { node, inserted: false };
    return {
      node: {
        type: "split",
        axis,
        children: insertBefore ? [newPane, node] : [node, newPane],
      },
      inserted: true,
    };
  }

  let inserted = false;
  const children = node.children.map((child) => {
    if (inserted) return child;
    const result = insertPaneIntoLayout(child, referencePaneId, newPane, axis, insertBefore);
    inserted = result.inserted;
    return result.node;
  });

  return {
    node: inserted ? { ...node, children } : node,
    inserted,
  };
}

function splitAxisForPlacement(placement: SplitPlacement): SplitAxis {
  return placement === "left" || placement === "right" ? "columns" : "rows";
}
