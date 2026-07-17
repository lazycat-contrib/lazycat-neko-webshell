import { isHerdrPaneResizeAction } from "./herdr-backend.ts";
import type { MessageKey } from "./i18n";
import type { TerminalPane, TerminalTab } from "./types";

export type PaneMenuAction =
  | "split-up"
  | "split-down"
  | "split-left"
  | "split-right"
  | "resize-up"
  | "resize-down"
  | "resize-left"
  | "resize-right"
  | "copy-selection"
  | "paste-clipboard"
  | "promote-session-to-tab"
  | "close-active-session";

export type NativePaneContextMenuItem = {
  label: string;
  shortcut?: string;
  enabled?: boolean;
  danger?: boolean;
  action: () => void | Promise<void>;
};

type PaneContextMenuOptions = {
  pane: TerminalPane;
  tab: TerminalTab | undefined;
  visiblePaneCount: (tab: TerminalTab) => number;
  translate: (key: MessageKey) => string;
  runAction: (action: PaneMenuAction) => void | Promise<void>;
};

const ACTION_LABELS: Record<PaneMenuAction, MessageKey> = {
  "split-up": "action.splitUp",
  "split-down": "action.splitDown",
  "split-left": "action.splitLeft",
  "split-right": "action.splitRight",
  "resize-up": "action.resizeUp",
  "resize-down": "action.resizeDown",
  "resize-left": "action.resizeLeft",
  "resize-right": "action.resizeRight",
  "copy-selection": "action.copySelection",
  "paste-clipboard": "action.pasteClipboard",
  "promote-session-to-tab": "action.promoteSessionToTab",
  "close-active-session": "action.closeActiveSession",
};

const ACTION_GROUPS: PaneMenuAction[][] = [
  ["split-up", "split-down", "split-left", "split-right"],
  ["resize-up", "resize-down", "resize-left", "resize-right"],
  ["copy-selection", "paste-clipboard", "promote-session-to-tab"],
  ["close-active-session"],
];

export function nativePaneContextMenuItems(
  options: PaneContextMenuOptions,
): Array<NativePaneContextMenuItem | "separator"> {
  const result: Array<NativePaneContextMenuItem | "separator"> = [];
  for (const group of ACTION_GROUPS) {
    const actions = group.filter((action) => paneMenuActionSupported(
      action,
      options.pane,
      options.tab,
      options.visiblePaneCount,
    ));
    if (actions.length === 0) continue;
    if (result.length > 0) result.push("separator");
    for (const action of actions) {
      result.push({
        label: options.translate(ACTION_LABELS[action]),
        danger: action === "close-active-session",
        action: () => options.runAction(action),
      });
    }
  }
  return result;
}

export function paneMenuActionSupported(
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
