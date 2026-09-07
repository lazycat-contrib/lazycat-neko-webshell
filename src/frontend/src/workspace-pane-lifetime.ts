import type { TerminalPane, TerminalTab, WorkspacePaneState } from "./types";
import { normalizeSelector } from "./workspace-selection.ts";
import { normalizeSessionMode } from "./session-backends.ts";
import { normalizeTerminalReplyAuthority } from "./terminal-reply-authority.ts";

export function createWorkspacePaneLifetime(options: {
  makePane: (tab: TerminalTab, id: string) => TerminalPane;
  disposePane: (pane: TerminalPane) => void;
  prepareReplay: (pane: TerminalPane) => void;
  initialCols: number;
  initialRows: number;
}) {
  const passive = new WeakSet<TerminalPane>();
  const disposed = new WeakSet<TerminalPane>();
  function dispose(pane: TerminalPane) {
    if (disposed.has(pane)) return;
    disposed.add(pane);
    options.disposePane(pane);
  }
  return {
    dispose,
    markPassive(pane: TerminalPane, value: boolean) {
      if (value) passive.add(pane); else passive.delete(pane);
    },
    mayRestart: (pane: TerminalPane) => !passive.has(pane),
    restore(tab: TerminalTab, state: WorkspacePaneState, existing?: TerminalPane, replay = false): TerminalPane {
      const backend = normalizeSessionMode(state.session_backend);
      const authority = normalizeTerminalReplyAuthority(state.terminal_reply_authority);
      const reusable = existing && !disposed.has(existing)
        && normalizeSelector(existing.selector) === normalizeSelector(tab.selector)
        && existing.sessionId === state.session_id
        && existing.sessionBackend === backend
        && existing.terminalReplyAuthority === authority;
      if (existing && !reusable) dispose(existing);
      const pane = reusable ? existing : options.makePane(tab, state.id);
      if (reusable && replay) options.prepareReplay(pane);
      pane.tabId = tab.id;
      pane.workspacePaneId = state.id;
      pane.selector = tab.selector;
      pane.label = tab.label;
      pane.sessionId = state.session_id;
      if (!reusable || replay) pane.workspaceRefreshPending = false;
      pane.sessionStatus = state.status;
      pane.sessionBackend = backend;
      pane.terminalReplyAuthority = authority;
      pane.programKind = state.program_kind;
      pane.serverCols = state.cols || options.initialCols;
      pane.serverRows = state.rows || options.initialRows;
      pane.cols = pane.localCols || pane.serverCols;
      pane.rows = pane.localRows || pane.serverRows;
      if (!pane.localCols || !pane.localRows) {
        pane.localCols = pane.serverCols;
        pane.localRows = pane.serverRows;
      }
      pane.exited = state.status === "exited";
      pane.closing = false;
      return pane;
    },
  };
}
