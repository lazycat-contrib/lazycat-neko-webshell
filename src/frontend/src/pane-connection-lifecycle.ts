import { reconnectDelayWithJitter } from "./pane-reconnect-policy.ts";
import type { TerminalPane, Tone } from "./types.ts";

type ConnectionMessageKey =
  | "status.connecting"
  | "status.offline"
  | "status.reconnecting"
  | "status.reconnectingNow"
  | "status.replayingTerminal"
  | "status.sessionStopped"
  | "status.shellReady";

export type PaneConnectionLifecycleOptions = {
  canConnect: (pane: TerminalPane) => boolean;
  autoRestartEnabled: () => boolean;
  isHerdr: (pane: TerminalPane) => boolean;
  isOnline: () => boolean;
  connect: (pane: TerminalPane) => void;
  setStatus: (pane: TerminalPane, message: string, tone?: Tone) => void;
  tr: (key: ConnectionMessageKey, values?: Record<string, string | number>) => string;
  recordReconnectDelay?: (delayMs: number) => void;
  random?: () => number;
  setTimer?: (callback: () => void, timeoutMs: number) => number;
  clearTimer?: (handle: number | undefined) => void;
};

export function createPaneConnectionLifecycle(options: PaneConnectionLifecycleOptions) {
  const random = options.random ?? Math.random;
  const setTimer = options.setTimer ?? window.setTimeout.bind(window);
  const clearTimer = options.clearTimer ?? window.clearTimeout.bind(window);

  function beginConnection(pane: TerminalPane): void {
    clearReconnect(pane);
    pane.connectionState = pane.hasConnected ? "reconnecting" : "connecting";
    options.setStatus(
      pane,
      options.tr(pane.hasConnected ? "status.reconnectingNow" : "status.connecting"),
      "neutral",
    );
  }

  function markReplaying(pane: TerminalPane): void {
    pane.connectionState = "replaying";
    options.setStatus(pane, options.tr("status.replayingTerminal"), "neutral");
  }

  function markConnected(pane: TerminalPane): void {
    clearReconnect(pane);
    pane.reconnectDelay = 1000;
    pane.connectionState = "connected";
    pane.hasConnected = true;
    options.setStatus(pane, options.tr("status.shellReady"), "ok");
  }

  function markTransientFailure(pane: TerminalPane): void {
    pane.connectionState = options.isOnline() ? "reconnecting" : "offline";
    options.setStatus(
      pane,
      options.tr(options.isOnline() ? "status.reconnectingNow" : "status.offline"),
      "neutral",
    );
  }

  function markFatal(pane: TerminalPane): void {
    clearReconnect(pane);
    pane.connectionState = "fatal";
  }

  function markIdle(pane: TerminalPane, message?: string): void {
    clearReconnect(pane);
    pane.connectionState = "idle";
    options.setStatus(pane, message ?? options.tr("status.sessionStopped"), "neutral");
  }

  function scheduleReconnect(pane: TerminalPane): void {
    if (!options.canConnect(pane)) return;
    if (
      pane.sessionStatus !== "running"
      && !options.autoRestartEnabled()
      && !options.isHerdr(pane)
    ) {
      markIdle(pane);
      return;
    }
    clearReconnect(pane);
    const backoff = reconnectDelayWithJitter(pane.reconnectDelay, random);
    // navigator.onLine is only a hint. LazyCat's LAN endpoint may remain reachable
    // without an Internet/default route, so retries must continue while "offline".
    const delayMs = options.isOnline() ? backoff.delayMs : Math.max(5_000, backoff.delayMs);
    options.recordReconnectDelay?.(delayMs);
    pane.reconnectDelay = backoff.nextBaseDelayMs;
    pane.connectionState = options.isOnline() ? "reconnecting" : "offline";
    options.setStatus(
      pane,
      options.isOnline()
        ? options.tr("status.reconnecting", { seconds: Math.max(1, Math.round(delayMs / 1000)) })
        : options.tr("status.offline"),
      "neutral",
    );
    pane.reconnectTimer = setTimer(() => {
      pane.reconnectTimer = undefined;
      options.connect(pane);
    }, delayMs);
  }

  function handleOfflineHint(panes: readonly TerminalPane[]): void {
    for (const pane of panes) {
      if (!options.canConnect(pane) || pane.connectionState === "connected") continue;
      if (pane.reconnectTimer === undefined) scheduleReconnect(pane);
      else {
        pane.connectionState = "offline";
        options.setStatus(pane, options.tr("status.offline"), "neutral");
      }
    }
  }

  function clearReconnect(pane: TerminalPane): void {
    clearTimer(pane.reconnectTimer);
    pane.reconnectTimer = undefined;
  }

  return {
    beginConnection,
    markReplaying,
    markConnected,
    markTransientFailure,
    markFatal,
    markIdle,
    scheduleReconnect,
    handleOfflineHint,
    clearReconnect,
  };
}
