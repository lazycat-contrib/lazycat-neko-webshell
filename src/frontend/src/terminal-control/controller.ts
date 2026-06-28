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
type ControlAction = "take-control" | "release-control";

type PaneControlState = {
  sessionId: string;
  connectionId: string;
  controllerId: string;
  connectionCount: number;
  controller: boolean;
};

type PendingControlRequest = {
  requestId: string;
  action: ControlAction;
  timer: number;
};

type ControlStateEvent = Extract<TerminalServerEvent, { type: "control-state" }>;

const CONTROL_ACK_TIMEOUT_MS = 5000;

export function createTerminalControlController(deps: TerminalControlControllerDeps) {
  const states = new Map<string, PaneControlState>();
  const pendingRequests = new Map<string, PendingControlRequest>();
  let requestSequence = 0;

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

  function pendingFor(pane: TerminalPane | undefined): PendingControlRequest | undefined {
    const key = paneStateKey(pane);
    return key ? pendingRequests.get(key) : undefined;
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
    const requestId = nextRequestId("take-control");
    try {
      setPendingRequest(pane, "take-control", requestId);
      debugControl("take terminal control request", pane, { requestId });
      pane.socket.send(webshellTakeControlMessage(requestId));
      return true;
    } catch (error) {
      clearPendingRequest(pane, requestId);
      debugControl("failed to send take terminal control request", pane, { error });
      deps.onStatus(deps.tr("status.terminalControlTakeFailed"), "error");
      return false;
    }
  }

  async function releaseControl(pane: TerminalPane | undefined = deps.activePane()): Promise<boolean> {
    if (!enabled() || !pane?.sessionId || pane.socket?.readyState !== WebSocket.OPEN) return false;
    const requestId = nextRequestId("release-control");
    try {
      setPendingRequest(pane, "release-control", requestId);
      debugControl("release terminal control request", pane, { requestId });
      pane.socket.send(webshellReleaseControlMessage(requestId));
      return true;
    } catch (error) {
      clearPendingRequest(pane, requestId);
      debugControl("failed to send release terminal control request", pane, { error });
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
    debugControl("terminal control state", pane, {
      requestId: event.request_id,
      action: event.control_action,
      controller: event.controller === true,
      controllerId: event.controller_id ?? "",
      connectionId: event.connection_id ?? "",
      connectionCount: normalizeConnectionCount(event.connection_count),
    });
    resolvePendingRequest(pane, event);
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
    failPendingRequest(pane);
    const state = stateFor(pane);
    if (state?.controller) {
      states.set(pane.id, { ...state, controller: false });
    }
    applyPaneObserverEffect(pane);
    render();
  }

  function forgetPane(pane: TerminalPane | undefined) {
    if (!pane) return;
    clearPendingRequest(pane);
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
        pendingAction: pendingFor(pane)?.action,
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

  function nextRequestId(action: ControlAction): string {
    requestSequence += 1;
    return `tc-${Date.now().toString(36)}-${requestSequence}-${action}`;
  }

  function setPendingRequest(pane: TerminalPane, action: ControlAction, requestId: string) {
    clearPendingRequest(pane, undefined, { render: false });
    const timer = window.setTimeout(() => {
      const pending = pendingFor(pane);
      if (!pending || pending.requestId !== requestId) return;
      pendingRequests.delete(pane.id);
      debugControl("terminal control request timed out", pane, { action, requestId });
      render();
      deps.onStatus(
        deps.tr(action === "take-control" ? "status.terminalControlTakeFailed" : "status.terminalControlReleaseFailed"),
        "error",
      );
    }, CONTROL_ACK_TIMEOUT_MS);
    pendingRequests.set(pane.id, { requestId, action, timer });
    render();
  }

  function clearPendingRequest(
    pane: TerminalPane,
    requestId?: string,
    options: { render?: boolean } = {},
  ) {
    const pending = pendingFor(pane);
    if (!pending || (requestId && pending.requestId !== requestId)) return;
    window.clearTimeout(pending.timer);
    pendingRequests.delete(pane.id);
    if (options.render !== false) {
      render();
    }
  }

  function failPendingRequest(pane: TerminalPane) {
    const pending = pendingFor(pane);
    if (!pending) return;
    clearPendingRequest(pane, pending.requestId, { render: false });
    deps.onStatus(
      deps.tr(pending.action === "take-control" ? "status.terminalControlTakeFailed" : "status.terminalControlReleaseFailed"),
      "error",
    );
  }

  function resolvePendingRequest(pane: TerminalPane, event: ControlStateEvent) {
    const pending = pendingFor(pane);
    if (!pending) return;
    if (event.request_id && event.request_id !== pending.requestId) return;
    if (!event.request_id && !pendingActionSatisfied(pending.action, event)) return;

    clearPendingRequest(pane, pending.requestId, { render: false });
    if (pending.action === "take-control") {
      if (event.controller === true) {
        deps.onStatus(deps.tr("status.terminalControlTaken"), "ok");
      } else {
        deps.onStatus(deps.tr("status.terminalControlTakeFailed"), "error");
      }
      return;
    }
    deps.onStatus(deps.tr("status.terminalControlReleased"), "ok");
  }

  function pendingActionSatisfied(action: ControlAction, event: ControlStateEvent): boolean {
    return action === "take-control" ? event.controller === true : event.controller !== true;
  }

  function debugControl(message: string, pane: TerminalPane, data: Record<string, unknown> = {}) {
    if (!deps.settings().debugMode) return;
    console.debug(message, {
      paneId: pane.id,
      sessionId: pane.sessionId ?? "",
      socketState: pane.socket?.readyState,
      ...data,
    });
  }

  deps.overlayRoot.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-control-action='take-control']")
      : null;
    if (!button) return;
    if (button.disabled) return;
    event.preventDefault();
    void takeControl();
  });

  deps.overlayRoot.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-control-action='release-control']")
      : null;
    if (!button) return;
    if (button.disabled) return;
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
