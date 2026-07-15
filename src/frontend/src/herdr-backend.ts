import { boolField, recordField, stringField } from "./json-meta.ts";
export { herdrEventSubscriptions } from "./herdr-socket-api.ts";
import type { JsonRecord, SplitPlacement, TerminalPane, TerminalTab, Tone } from "./types";

export type HerdrPaneResizeDirection = "left" | "right" | "up" | "down";

const HERDR_SPLIT_DIRECTIONS: Partial<Record<SplitPlacement, "right" | "down">> = {
  right: "right",
  down: "down",
};

const HERDR_PANE_RESIZE_DIRECTIONS: Partial<Record<string, HerdrPaneResizeDirection>> = {
  "resize-up": "up",
  "resize-down": "down",
  "resize-left": "left",
  "resize-right": "right",
};

export const HERDR_PANE_RESIZE_AMOUNT = 0.05;

const SILENT_HERDR_EVENTS = new Set([
  "layout.updated",
  "pane.scroll_changed",
  "workspace.metadata_updated",
  "pane.updated",
]);

export function herdrSplitDirection(placement: SplitPlacement): "right" | "down" | undefined {
  return HERDR_SPLIT_DIRECTIONS[placement];
}

export function herdrResizeDirectionForPaneAction(action: string): HerdrPaneResizeDirection | undefined {
  return HERDR_PANE_RESIZE_DIRECTIONS[action];
}

export function isHerdrPaneResizeAction(action: string): boolean {
  return action in HERDR_PANE_RESIZE_DIRECTIONS;
}

export function selectHerdrTerminalPane(
  tab: TerminalTab | undefined,
  preferredPane?: TerminalPane,
): TerminalPane | undefined {
  if (!tab) return undefined;
  if (
    preferredPane
    && preferredPane.tabId === tab.id
    && preferredPane.sessionBackend === "herdr"
    && !preferredPane.closing
  ) {
    return preferredPane;
  }
  return tab.panes.find((pane) => pane.sessionBackend === "herdr" && !pane.closing);
}

export function herdrEventSocketUrl(selector: string): URL {
  const url = new URL("./ws/herdr", window.location.href);
  url.protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("name", selector);
  return url;
}

export function herdrPaneIdsFromListResult(result: JsonRecord | undefined): string[] {
  const panes = result?.panes;
  if (!Array.isArray(panes)) return [];
  return panes
    .map((pane) => pane && typeof pane === "object" ? stringField(pane as JsonRecord, "pane_id") : "")
    .filter(Boolean);
}

export function herdrCurrentPaneId(result: JsonRecord | undefined): string {
  return stringField(recordField(result, "pane"), "pane_id");
}

export function herdrProcessWorkingDirectory(result: JsonRecord | undefined): string {
  const process = recordField(result, "process")
    ?? recordField(result, "process_info")
    ?? recordField(result, "info")
    ?? result;
  return stringField(process, "cwd")
    || stringField(process, "current_working_directory")
    || stringField(process, "working_directory");
}

export function herdrFocusedOrFirstPaneId(result: JsonRecord | undefined): string {
  const panes = Array.isArray(result?.panes) ? result.panes : [];
  const records = panes
    .filter((item): item is JsonRecord => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  const focusedPane = records.find((item) => boolField(item, "focused"));
  return stringField(focusedPane ?? records[0], "pane_id");
}

export function herdrEventTone(event: string, data: JsonRecord): Tone {
  if (event === "pane.exited") return "error";
  const status = stringField(data, "agent_status") || stringField(data, "state");
  if (status === "blocked") return "error";
  if (status === "done" || status === "idle") return "ok";
  return "neutral";
}

export function herdrEventChangesDock(event: string): boolean {
  return event.startsWith("workspace.")
    || event.startsWith("worktree.")
    || event.startsWith("tab.")
    || event === "pane.created"
    || event === "pane.closed"
    || event === "pane.updated"
    || event === "pane.focused"
    || event === "pane.moved"
    || event === "pane.exited"
    || event === "layout.updated";
}

export function herdrEventShowsStatus(event: string): boolean {
  return !SILENT_HERDR_EVENTS.has(event);
}
