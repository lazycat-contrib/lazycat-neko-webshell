import type { TerminalPane } from "../types";
import { webshellReleaseControlMessage } from "../webshell-backend";
import { currentTerminalControlActor } from "./actor";

export type TerminalControlReleaseController = {
  isController: (pane: TerminalPane | undefined) => boolean;
};

type ReleaseControlledTerminalPanesOptions = {
  keepalive?: boolean;
};

const RELEASE_CONTROL_ENDPOINT = "./api/terminal-control/release";

export function releaseControlledTerminalPanes(
  panes: Iterable<TerminalPane>,
  controller: TerminalControlReleaseController,
  options: ReleaseControlledTerminalPanesOptions = {},
) {
  const actor = currentTerminalControlActor();
  for (const pane of panes) {
    if (!controller.isController(pane)) continue;
    if (pane.sessionId) {
      releaseActorControlLease(pane.sessionId, actor.actorId, options);
    }
    if (pane.socket?.readyState !== WebSocket.OPEN) continue;
    try {
      pane.socket.send(webshellReleaseControlMessage());
    } catch {
      // The page may be unloading; the backend also releases on socket close.
    }
  }
}

export function shouldReleaseTerminalControlWhenHidden(): boolean {
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

function releaseActorControlLease(
  sessionId: string,
  actorId: string,
  options: ReleaseControlledTerminalPanesOptions,
) {
  const body = JSON.stringify({ sessionId, actorId });
  const url = new URL(RELEASE_CONTROL_ENDPOINT, window.location.href);
  if (options.keepalive && navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(url, blob)) return;
  }
  void fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: options.keepalive,
  }).catch(() => undefined);
}
