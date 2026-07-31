import contract from "../../herdr_socket_contract.json" with { type: "json" };

import type { HerdrAgentInfo, HerdrPaneInfo, HerdrSocketEnvelope, HerdrWorkspaceInfo, JsonRecord } from "./types";

export const HERDR_SOCKET_PROTOCOL = contract.protocol;
export const HERDR_SOCKET_SCHEMA_VERSION = contract.schema_version;
export const HERDR_SOCKET_SOURCE_VERSION = contract.source_version;
export const HERDR_SOCKET_SOURCE_REVISION = contract.source_revision;

const HERDR_SOCKET_METHODS = new Set(contract.methods);
const HERDR_SOCKET_SUBSCRIPTIONS = new Set(contract.subscriptions);
const HERDR_EVENT_NAMES = new Map(contract.subscriptions.flatMap((event) => [
  [event, event],
  [event.replace(".", "_"), event],
]));
const HERDR_METADATA_EVENT_MIN_VERSION = [0, 7, 4] as const;

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

const METADATA_EVENT_SUBSCRIPTIONS = [
  "workspace.metadata_updated",
  "pane.updated",
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

export function normalizeHerdrSocketEnvelope(
  envelope: HerdrSocketEnvelope,
): HerdrSocketEnvelope {
  const event = envelope.event ? HERDR_EVENT_NAMES.get(envelope.event) : undefined;
  return event && event !== envelope.event ? { ...envelope, event } : envelope;
}

export function herdrEventSubscriptions(
  paneIds: string[],
  herdrVersion = HERDR_SOCKET_SOURCE_VERSION,
): JsonRecord[] {
  const subscriptions: JsonRecord[] = BASE_EVENT_SUBSCRIPTIONS.map((type) => ({ type }));
  if (herdrVersionAtLeast(herdrVersion, HERDR_METADATA_EVENT_MIN_VERSION)) {
    subscriptions.push(...METADATA_EVENT_SUBSCRIPTIONS.map((type) => ({ type })));
  }
  for (const paneId of uniqueNonEmpty(paneIds)) {
    subscriptions.push({ type: "pane.agent_status_changed", pane_id: paneId });
  }
  return subscriptions;
}

function herdrVersionAtLeast(
  version: string,
  minimum: readonly [number, number, number],
): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());
  if (!match) return false;
  const actual = match.slice(1, 4).map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] > minimum[index]) return true;
    if (actual[index] < minimum[index]) return false;
  }
  return true;
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

export function herdrWorkspaceInfoFromEvent(data: JsonRecord): HerdrWorkspaceInfo | undefined {
  const workspace = recordField(data, "workspace") ?? data;
  const workspaceId = stringField(workspace, "workspace_id");
  const label = stringField(workspace, "label");
  const activeTabId = stringField(workspace, "active_tab_id");
  const number = nonNegativeInteger(workspace.number);
  const tabCount = nonNegativeInteger(workspace.tab_count);
  const paneCount = nonNegativeInteger(workspace.pane_count);
  const focused = booleanField(workspace, "focused");
  const tokens = metadataTokens(workspace.tokens);
  if (
    !workspaceId
    || !label
    || !activeTabId
    || number === undefined
    || tabCount === undefined
    || paneCount === undefined
    || focused === undefined
    || tokens === undefined
  ) {
    return undefined;
  }
  return {
    workspace_id: workspaceId,
    number,
    label,
    focused,
    active_tab_id: activeTabId,
    tab_count: tabCount,
    pane_count: paneCount,
    tokens,
  };
}

export function herdrPaneInfoFromEvent(data: JsonRecord): HerdrPaneInfo | undefined {
  const pane = recordField(data, "pane") ?? data;
  const paneId = stringField(pane, "pane_id");
  const workspaceId = stringField(pane, "workspace_id");
  const tabId = stringField(pane, "tab_id");
  const focused = booleanField(pane, "focused");
  const agentStatus = stringField(pane, "agent_status");
  const tokens = metadataTokens(pane.tokens);
  if (
    !paneId
    || !workspaceId
    || !tabId
    || focused === undefined
    || !agentStatus
    || tokens === undefined
  ) {
    return undefined;
  }
  return {
    pane_id: paneId,
    workspace_id: workspaceId,
    tab_id: tabId,
    focused,
    ...optionalStringFields(pane, [
      "title",
      "terminal_title",
      "terminal_title_stripped",
      "display_agent",
      "agent",
    ]),
    agent_status: agentStatus,
    tokens,
  };
}

export function herdrAgentInfo(value: JsonRecord | undefined): HerdrAgentInfo | undefined {
  const agent = recordField(value, "agent") ?? value;
  if (!agent) return undefined;
  const terminalId = stringField(agent, "terminal_id");
  const agentStatus = stringField(agent, "agent_status");
  const workspaceId = stringField(agent, "workspace_id");
  const tabId = stringField(agent, "tab_id");
  const paneId = stringField(agent, "pane_id");
  const focused = booleanField(agent, "focused");
  const revision = nonNegativeInteger(agent?.revision);
  const launchPending = optionalBooleanField(agent, "launch_pending", false);
  const interactiveReady = optionalBooleanField(agent, "interactive_ready", false);
  const stateChangeSeq = optionalNonNegativeInteger(agent?.state_change_seq, 0);
  const tokens = metadataTokens(agent?.tokens);
  if (
    !terminalId
    || !agentStatus
    || !workspaceId
    || !tabId
    || !paneId
    || focused === undefined
    || revision === undefined
    || launchPending === undefined
    || interactiveReady === undefined
    || stateChangeSeq === undefined
    || tokens === undefined
  ) {
    return undefined;
  }
  return {
    terminal_id: terminalId,
    ...optionalStringFields(agent, [
      "name",
      "agent",
      "display_agent",
    ]),
    agent_status: agentStatus,
    workspace_id: workspaceId,
    tab_id: tabId,
    pane_id: paneId,
    focused,
    revision,
    launch_pending: launchPending,
    interactive_ready: interactiveReady,
    state_change_seq: stateChangeSeq,
    ...optionalStringFields(agent, [
      "title",
      "terminal_title",
      "terminal_title_stripped",
    ]),
    tokens,
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

function booleanField(record: JsonRecord | undefined, key: string): boolean | undefined {
  const value = record?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function optionalBooleanField(
  record: JsonRecord | undefined,
  key: string,
  fallback: boolean,
): boolean | undefined {
  if (!record || !(key in record)) return fallback;
  return booleanField(record, key);
}

function optionalNonNegativeInteger(value: unknown, fallback: number): number | undefined {
  return value === undefined ? fallback : nonNegativeInteger(value);
}

function metadataTokens(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, token]) => typeof token !== "string")) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}

function optionalStringFields<const K extends string>(
  record: JsonRecord,
  keys: readonly K[],
): Partial<Record<K, string>> {
  const result: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const value = stringField(record, key);
    if (value) result[key] = value;
  }
  return result;
}

function stringField(record: JsonRecord | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function recordField(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  const value = record?.[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
}
