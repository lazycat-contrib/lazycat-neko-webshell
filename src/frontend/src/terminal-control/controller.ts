import type { MessageKey } from "../i18n";
import type { TerminalServerEvent } from "../terminal-protocol";
import type { Settings, TerminalPane, Tone } from "../types";
import { webshellReleaseControlMessage, webshellTakeControlMessage } from "../webshell-backend";
import { renderTerminalControlOverlayView } from "./overlay-view";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type TerminalControlControllerDeps = {
  settings: () => Settings;
  overlayRoot: HTMLElement;
  activePane: () => TerminalPane | undefined;
  panes: () => TerminalPane[];
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  onRenderIcons: () => void;
  onTakeControlResize: (pane: TerminalPane) => void;
};

type AttachControlParams = {
  controlMode?: "single";
  cols: number;
  rows: number;
};

type ControlMode = "controller" | "observer" | "unknown";

type PaneControlState = {
  sessionId: string;
  connectionId: string;
  controllerId: string;
  connectionCount: number;
  controller: boolean;
};

type ControlStateEvent = Extract<TerminalServerEvent, { type: "control-state" }>;

export function createTerminalControlController(deps: TerminalControlControllerDeps) {
  const states = new Map<string, PaneControlState>();

  function enabled(): boolean {
    return deps.settings().terminalSingleControllerMode;
  }

  function paneSessionId(pane: TerminalPane | undefined): string {
    return pane?.sessionId?.trim() ?? "";
  }

  function paneStateKey(pane: TerminalPane | undefined): string {
    return pane?.id ?? "";
  }

  function stateFor(pane: TerminalPane | undefined): PaneControlState | undefined {
    const key = paneStateKey(pane);
    return key ? states.get(key) : undefined;
  }

  function modeFor(pane: TerminalPane | undefined): ControlMode {
    if (!enabled() || !paneSessionId(pane)) return "unknown";
    const state = stateFor(pane);
    if (!state) return "unknown";
    return state.controller ? "controller" : "observer";
  }

  function localSize(pane: TerminalPane): { cols: number; rows: number } {
    return {
      cols: pane.localCols || pane.cols || 120,
      rows: pane.localRows || pane.rows || 32,
    };
  }

  function serverSize(pane: TerminalPane): { cols: number; rows: number } {
    return {
      cols: pane.serverCols || pane.cols || 120,
      rows: pane.serverRows || pane.rows || 32,
    };
  }

  async function prepareAttach(pane: TerminalPane): Promise<AttachControlParams> {
    const size = localSize(pane);
    if (!enabled() || !pane.sessionId) {
      return size;
    }
    return {
      controlMode: "single",
      ...size,
    };
  }

  async function takeControl(pane: TerminalPane | undefined = deps.activePane()): Promise<boolean> {
    if (!enabled() || !pane?.sessionId || pane.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      pane.socket.send(webshellTakeControlMessage());
      deps.onStatus(deps.tr("status.terminalControlTaken"), "ok");
      return true;
    } catch (error) {
      console.debug("failed to take terminal control", error);
      deps.onStatus(deps.tr("status.terminalControlTakeFailed"), "error");
      return false;
    }
  }

  async function releaseControl(pane: TerminalPane | undefined = deps.activePane()): Promise<boolean> {
    if (!enabled() || !pane?.sessionId || pane.socket?.readyState !== WebSocket.OPEN) return false;
    try {
      pane.socket.send(webshellReleaseControlMessage());
      deps.onStatus(deps.tr("status.terminalControlReleased"), "ok");
      return true;
    } catch (error) {
      console.debug("failed to release terminal control", error);
      deps.onStatus(deps.tr("status.terminalControlReleaseFailed"), "error");
      return false;
    }
  }

  function isController(pane: TerminalPane | undefined): boolean {
    return modeFor(pane) === "controller";
  }

  function canWrite(pane: TerminalPane | undefined, options: { report?: boolean } = {}): boolean {
    if (!enabled()) return true;
    if (modeFor(pane) === "controller") return true;
    if (options.report !== false) {
      deps.onStatus(deps.tr("status.terminalControlObserver"), "neutral");
    }
    return false;
  }

  function noteControlState(pane: TerminalPane, event: ControlStateEvent) {
    const previous = modeFor(pane);
    states.set(pane.id, {
      sessionId: event.session_id ?? pane.sessionId ?? "",
      connectionId: event.connection_id ?? "",
      controllerId: event.controller_id ?? "",
      connectionCount: normalizeConnectionCount(event.connection_count),
      controller: event.controller === true,
    });
    applyPaneObserverEffect(pane);
    render();
    if (previous !== "controller" && modeFor(pane) === "controller") {
      deps.onTakeControlResize(pane);
    }
  }

  function noteServerSize(pane: TerminalPane, cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    pane.serverCols = Math.max(1, Math.trunc(cols));
    pane.serverRows = Math.max(1, Math.trunc(rows));
  }

  function noteLocalSize(pane: TerminalPane, cols: number, rows: number) {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    pane.localCols = Math.max(1, Math.trunc(cols));
    pane.localRows = Math.max(1, Math.trunc(rows));
  }

  function handleRejectedWrite(pane: TerminalPane | undefined) {
    if (!enabled() || !pane?.sessionId) return;
    const state = stateFor(pane);
    if (state?.controller) {
      states.set(pane.id, { ...state, controller: false });
    }
    applyPaneObserverEffect(pane);
    render();
  }

  function forgetPane(pane: TerminalPane | undefined) {
    if (!pane) return;
    states.delete(pane.id);
    applyPaneObserverEffect(pane);
    render();
  }

  function render() {
    refreshPaneEffects();
    const pane = deps.activePane();
    const mode = modeFor(pane);
    const active = Boolean(enabled() && pane && mode !== "unknown");
    deps.overlayRoot.hidden = !active;
    deps.overlayRoot.innerHTML = active
      ? renderTerminalControlOverlayView({
        enabled: true,
        mode,
        label: deps.tr(mode === "controller" ? "terminalControl.controller" : "terminalControl.observer"),
        detail: overlayDetail(pane!, mode),
        takeControlTitle: deps.tr("action.takeTerminalControl"),
        releaseControlTitle: deps.tr("action.releaseTerminalControl"),
      })
      : "";
    deps.onRenderIcons();
  }

  function refreshPaneEffects() {
    for (const pane of deps.panes()) {
      applyPaneObserverEffect(pane);
    }
  }

  function applyPaneObserverEffect(pane: TerminalPane) {
    const shouldBlur = Boolean(
      enabled()
        && deps.settings().terminalBlurObservers
        && modeFor(pane) === "observer",
    );
    pane.mount.classList.toggle("terminal-observer-blur", shouldBlur);
  }

  function overlayDetail(pane: TerminalPane, mode: ControlMode): string {
    const size = mode === "controller" ? localSize(pane) : serverSize(pane);
    return mode === "controller"
      ? deps.tr("terminalControl.localSize", { cols: size.cols, rows: size.rows })
      : deps.tr("terminalControl.serverSize", { cols: size.cols, rows: size.rows });
  }

  deps.overlayRoot.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-control-action='take-control']")
      : null;
    if (!button) return;
    event.preventDefault();
    void takeControl();
  });

  deps.overlayRoot.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-control-action='release-control']")
      : null;
    if (!button) return;
    event.preventDefault();
    void releaseControl();
  });

  return {
    enabled,
    prepareAttach,
    takeControl,
    releaseControl,
    isController,
    canWrite,
    noteControlState,
    noteServerSize,
    noteLocalSize,
    handleRejectedWrite,
    forgetPane,
    render,
    refreshPaneEffects,
  };
}

function normalizeConnectionCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}
