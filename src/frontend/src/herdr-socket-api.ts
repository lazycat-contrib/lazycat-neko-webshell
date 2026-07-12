import contract from "../../herdr_socket_contract.json" with { type: "json" };

import type { JsonRecord } from "./types";

export const HERDR_SOCKET_PROTOCOL = contract.protocol;
export const HERDR_SOCKET_SCHEMA_VERSION = contract.schema_version;
export const HERDR_SOCKET_SOURCE_VERSION = contract.source_version;
export const HERDR_SOCKET_SOURCE_REVISION = contract.source_revision;

const HERDR_SOCKET_METHODS = new Set(contract.methods);
const HERDR_SOCKET_SUBSCRIPTIONS = new Set(contract.subscriptions);

const BASE_EVENT_SUBSCRIPTIONS = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.moved",
  "workspace.closed",
  "workspace.focused",
  "worktree.created",
  "worktree.opened",
  "worktree.removed",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "tab.moved",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
  "layout.updated",
] as const;

export type HerdrPaneScrollInfo = {
  offsetFromBottom: number;
  maxOffsetFromBottom: number;
  viewportRows: number;
};

export type HerdrPaneSocketInfo = {
  paneId: string;
  workspaceId: string;
  scroll?: HerdrPaneScrollInfo;
};

export function isHerdrSocketMethod(method: string): boolean {
  return HERDR_SOCKET_METHODS.has(method);
}

export function isHerdrSocketSubscription(type: string): boolean {
  return HERDR_SOCKET_SUBSCRIPTIONS.has(type);
}

export function herdrEventSubscriptions(paneIds: string[]): JsonRecord[] {
  const subscriptions: JsonRecord[] = BASE_EVENT_SUBSCRIPTIONS.map((type) => ({ type }));
  for (const paneId of uniqueNonEmpty(paneIds)) {
    subscriptions.push({ type: "pane.agent_status_changed", pane_id: paneId });
  }
  return subscriptions;
}

export function herdrPaneInfo(value: JsonRecord | undefined): HerdrPaneSocketInfo | undefined {
  const pane = recordField(value, "pane") ?? value;
  const paneId = stringField(pane, "pane_id");
  if (!paneId) return undefined;
  const scroll = herdrPaneScrollInfo(recordField(pane, "scroll"));
  return {
    paneId,
    workspaceId: stringField(pane, "workspace_id"),
    ...(scroll ? { scroll } : {}),
  };
}

export function herdrPaneIdFromEvent(data: JsonRecord): string {
  return stringField(data, "pane_id") || stringField(recordField(data, "pane"), "pane_id");
}

export function herdrScrollInfoFromEvent(data: JsonRecord): HerdrPaneScrollInfo | undefined {
  return herdrPaneScrollInfo(recordField(data, "scroll"));
}

function herdrPaneScrollInfo(scroll: JsonRecord | undefined): HerdrPaneScrollInfo | undefined {
  const offsetFromBottom = nonNegativeInteger(scroll?.offset_from_bottom);
  const maxOffsetFromBottom = nonNegativeInteger(scroll?.max_offset_from_bottom);
  const viewportRows = positiveInteger(scroll?.viewport_rows);
  if (
    offsetFromBottom === undefined
    || maxOffsetFromBottom === undefined
    || viewportRows === undefined
    || offsetFromBottom > maxOffsetFromBottom
  ) {
    return undefined;
  }
  return { offsetFromBottom, maxOffsetFromBottom, viewportRows };
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const integer = nonNegativeInteger(value);
  return integer !== undefined && integer > 0 ? integer : undefined;
}

function stringField(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function recordField(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
