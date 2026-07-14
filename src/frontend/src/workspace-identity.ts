import type { SplitNode } from "./types";
import { normalizeSelector } from "./workspace-selection.ts";

type WorkspaceEntityKind = "tab" | "pane";

const PREFIX = "workspace";

export function workspaceEntityId(
  selector: string,
  kind: WorkspaceEntityKind,
  rawId: string,
): string {
  const encodedSelector = encodeURIComponent(normalizeSelector(selector));
  const encodedRawId = encodeURIComponent(String(rawId ?? "").trim());
  return `${PREFIX}:${kind}:${encodedSelector}:${encodedRawId}`;
}

export function workspaceLayoutToView(
  selector: string,
  layout: SplitNode | undefined,
): SplitNode | undefined {
  return mapLayout(selector, layout, "pane", true);
}

export function workspaceLayoutToRaw(
  selector: string,
  layout: SplitNode | undefined,
): SplitNode | undefined {
  return mapLayout(selector, layout, "pane", false);
}

function mapLayout(
  selector: string,
  layout: SplitNode | undefined,
  kind: WorkspaceEntityKind,
  toView: boolean,
): SplitNode | undefined {
  if (!layout) return undefined;
  if (layout.type === "pane") {
    if (toView) {
      return { type: "pane", paneId: workspaceEntityId(selector, kind, layout.paneId) };
    }
    const raw = rawWorkspaceEntityId(selector, kind, layout.paneId);
    return raw ? { type: "pane", paneId: raw } : undefined;
  }
  const children = layout.children
    .map((child) => mapLayout(selector, child, kind, toView))
    .filter((child): child is SplitNode => Boolean(child));
  return children.length === layout.children.length && children.length > 0
    ? { type: "split", axis: layout.axis, children }
    : undefined;
}

function rawWorkspaceEntityId(
  selector: string,
  kind: WorkspaceEntityKind,
  value: string,
): string | undefined {
  const prefix = `${PREFIX}:${kind}:${encodeURIComponent(normalizeSelector(selector))}:`;
  if (!value.startsWith(prefix)) return undefined;
  const raw = decodeURIComponent(value.slice(prefix.length));
  return raw || undefined;
}
