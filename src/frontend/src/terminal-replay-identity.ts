export type TerminalReplayIdentity = {
  sessionId?: string;
  workspacePaneId: string;
};

export type TerminalReplayIdentityEvent = {
  session_id?: string;
  pane_id?: string;
};

export function matchesTerminalReplayIdentity(
  pane: TerminalReplayIdentity,
  event: TerminalReplayIdentityEvent,
): boolean {
  return Boolean(
    event.session_id
      && event.pane_id
      && event.session_id === pane.sessionId
      && event.pane_id === pane.workspacePaneId,
  );
}
