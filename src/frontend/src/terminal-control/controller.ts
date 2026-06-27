import type { Client } from "@connectrpc/connect";

import type { ControlLease } from "../gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "../i18n";
import type { Settings, TerminalPane, Tone } from "../types";
import { currentTerminalControlActor } from "./actor";
import { renderTerminalControlOverlayView } from "./overlay-view";

type CapabilityClient = Client<typeof import("../gen/lazycat/webshell/v1/capability_pb").CapabilityService>;

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type TerminalControlControllerDeps = {
  capabilityClient: CapabilityClient;
  settings: () => Settings;
  overlayRoot: HTMLElement;
  activePane: () => TerminalPane | undefined;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
  onRenderIcons: () => void;
  onTakeControlResize: (pane: TerminalPane) => void;
};

type AttachControlParams = {
  controlMode?: "single";
  actorId?: string;
  actorKind?: string;
  cols: number;
  rows: number;
};

type ControlMode = "controller" | "observer" | "unknown";

export function createTerminalControlController(deps: TerminalControlControllerDeps) {
  const leases = new Map<string, ControlLease>();

  function enabled(): boolean {
    return deps.settings().terminalSingleControllerMode;
  }

  function paneSessionId(pane: TerminalPane | undefined): string {
    return pane?.sessionId?.trim() ?? "";
  }

  function leaseFor(pane: TerminalPane | undefined): ControlLease | undefined {
    const sessionId = paneSessionId(pane);
    return sessionId ? leases.get(sessionId) : undefined;
  }

  function modeFor(pane: TerminalPane | undefined): ControlMode {
    if (!enabled() || !paneSessionId(pane)) return "unknown";
    const lease = leaseFor(pane);
    if (!lease?.actorId) return "unknown";
    return lease.actorId === currentTerminalControlActor().actorId ? "controller" : "observer";
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
    const local = localSize(pane);
    if (!enabled() || !pane.sessionId) {
      return { ...local };
    }
    const actor = currentTerminalControlActor();
    try {
      const response = await deps.capabilityClient.requestControl({
        sessionId: pane.sessionId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        reason: "attach",
      }, { timeoutMs: 5000 });
      if (response.lease) {
        leases.set(pane.sessionId, response.lease);
      }
    } catch (error) {
      console.debug("failed to prepare terminal control lease", error);
      deps.onStatus(deps.tr("status.terminalControlSyncFailed"), "error");
    }
    render();
    const isController = modeFor(pane) === "controller";
    const size = isController ? local : serverSize(pane);
    return {
      controlMode: "single",
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      ...size,
    };
  }

  async function takeControl(pane: TerminalPane | undefined = deps.activePane()): Promise<boolean> {
    if (!enabled() || !pane?.sessionId) return false;
    const actor = currentTerminalControlActor();
    try {
      const response = await deps.capabilityClient.requestControl({
        sessionId: pane.sessionId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        reason: "takeover",
      }, { timeoutMs: 5000 });
      if (response.lease) {
        leases.set(pane.sessionId, response.lease);
      }
      render();
      deps.onTakeControlResize(pane);
      deps.onStatus(deps.tr("status.terminalControlTaken"), "ok");
      return true;
    } catch (error) {
      console.debug("failed to take terminal control", error);
      deps.onStatus(deps.tr("status.terminalControlTakeFailed"), "error");
      return false;
    }
  }

  function canWrite(pane: TerminalPane | undefined, options: { report?: boolean } = {}): boolean {
    if (!enabled()) return true;
    if (modeFor(pane) === "controller") return true;
    if (options.report !== false) {
      deps.onStatus(deps.tr("status.terminalControlObserver"), "neutral");
    }
    return false;
  }

  function noteLease(sessionId: string | undefined, lease: ControlLease | undefined) {
    if (!sessionId || !lease?.actorId) return;
    leases.set(sessionId, lease);
    render();
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
    const existing = leases.get(pane.sessionId);
    if (existing?.actorId === currentTerminalControlActor().actorId) {
      leases.delete(pane.sessionId);
    }
    render();
  }

  function render() {
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
      })
      : "";
    deps.onRenderIcons();
  }

  function overlayDetail(pane: TerminalPane, mode: ControlMode): string {
    const size = mode === "controller" ? localSize(pane) : serverSize(pane);
    const label = mode === "controller"
      ? deps.tr("terminalControl.localSize", { cols: size.cols, rows: size.rows })
      : deps.tr("terminalControl.serverSize", { cols: size.cols, rows: size.rows });
    return label;
  }

  deps.overlayRoot.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-control-action='take-control']")
      : null;
    if (!button) return;
    event.preventDefault();
    void takeControl();
  });

  return {
    enabled,
    prepareAttach,
    takeControl,
    canWrite,
    noteLease,
    noteServerSize,
    noteLocalSize,
    handleRejectedWrite,
    render,
  };
}
