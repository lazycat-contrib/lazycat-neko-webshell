import type { SessionBackendId } from "./types";

export type PaneReconnectState = {
  sessionId?: string;
  sessionStatus?: string;
  sessionBackend: SessionBackendId;
  processExitObserved?: boolean;
  fatalErrorObserved?: boolean;
  exited?: boolean;
  closing?: boolean;
};

export function terminalErrorBlocksReconnect(
  event: { fatal?: boolean; retryable?: boolean },
): boolean {
  return event.fatal === true && event.retryable === false;
}

export function shouldConnectRestoredPane(
  pane: PaneReconnectState,
  autoRestart: boolean,
): boolean {
  if (!pane.sessionId || pane.sessionStatus === "closed") return false;
  if (pane.sessionBackend === "herdr") {
    return pane.processExitObserved !== true;
  }
  if (pane.sessionStatus === "exited") return false;
  if (
    pane.sessionStatus === "running"
    || pane.sessionStatus === "starting"
    || pane.sessionStatus === "stopped"
  ) {
    return true;
  }
  return autoRestart;
}

export function canConnectPane(
  pane: PaneReconnectState,
  autoRestart: boolean,
): boolean {
  if (pane.closing || pane.fatalErrorObserved === true || !pane.sessionId) return false;
  if (pane.sessionBackend === "herdr" && pane.processExitObserved === true) {
    return false;
  }
  return pane.exited !== true || shouldConnectRestoredPane(pane, autoRestart);
}
