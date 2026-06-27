import type { TerminalPane } from "../types";
import { webshellReleaseControlMessage } from "../webshell-backend";

export type TerminalControlReleaseController = {
  isController: (pane: TerminalPane | undefined) => boolean;
};

export function releaseControlledTerminalPanes(
  panes: Iterable<TerminalPane>,
  controller: TerminalControlReleaseController,
) {
  for (const pane of panes) {
    if (!controller.isController(pane)) continue;
    if (pane.socket?.readyState !== WebSocket.OPEN) continue;
    try {
      pane.socket.send(webshellReleaseControlMessage());
    } catch {
      // The page may be unloading; the backend also releases on socket close.
    }
  }
}
