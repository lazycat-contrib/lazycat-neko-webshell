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

const CONTROL_SYNC_INTERVAL_MS = 1500;
const RELEASE_RECLAIM_COOLDOWN_MS = 6000;

export function createTerminalControlController(deps: TerminalControlControllerDeps) {
  const leases = new Map<string, ControlLease>();
  const releasedUntil = new Map<string, number>();
  let syncInFlight = false;
  let leaseMutationSerial = 0;
  let leaseMutationsInFlight = 0;

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

  function activeLease(lease: ControlLease | undefined): lease is ControlLease {
    const status = lease?.status?.trim().toLowerCase();
    return Boolean(lease?.actorId?.trim() && (!status || status === "active"));
  }

  function rememberLease(sessionId: string | undefined, lease: ControlLease | undefined) {
    if (!sessionId) return;
    if (activeLease(lease)) {
      leases.set(sessionId, lease);
    } else {
      leases.delete(sessionId);
    }
  }

  function releaseCooldownActive(sessionId: string): boolean {
    const until = releasedUntil.get(sessionId) ?? 0;
    if (until > Date.now()) return true;
    releasedUntil.delete(sessionId);
    return false;
  }

  function modeFor(pane: TerminalPane | undefined): ControlMode {
    if (!enabled() || !paneSessionId(pane)) return "unknown";
    const lease = leaseFor(pane);
    if (!lease?.actorId) return "unknown";
    return lease.actorId === currentTerminalControlActor().actorId ? "controller" : "observer";
  }

  function isController(pane: TerminalPane | undefined): boolean {
    return modeFor(pane) === "controller";
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
    try {
      await requestControlLease(pane, "attach");
    } catch (error) {
      console.debug("failed to prepare terminal control lease", error);
      deps.onStatus(deps.tr("status.terminalControlSyncFailed"), "error");
    }
    render();
    const isController = modeFor(pane) === "controller";
    const size = isController ? local : serverSize(pane);
    const actor = currentTerminalControlActor();
    return {
      controlMode: "single",
      actorId: actor.actorId,
      actorKind: actor.actorKind,
      ...size,
    };
  }

  async function takeControl(pane: TerminalPane | undefined = deps.activePane()): Promise<boolean> {
    if (!enabled() || !pane?.sessionId) return false;
    try {
      releasedUntil.delete(pane.sessionId);
      await requestControlLease(pane, "takeover");
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

  async function releaseControl(pane: TerminalPane | undefined = deps.activePane()): Promise<boolean> {
    if (!enabled() || !pane?.sessionId) return false;
    const lease = leaseFor(pane);
    if (modeFor(pane) !== "controller" || !lease?.leaseId) return false;
    releasedUntil.set(pane.sessionId, Date.now() + RELEASE_RECLAIM_COOLDOWN_MS);
    const serial = ++leaseMutationSerial;
    leaseMutationsInFlight += 1;
    try {
      await deps.capabilityClient.releaseControl({
        sessionId: pane.sessionId,
        leaseId: lease.leaseId,
      }, { timeoutMs: 5000 });
      if (serial === leaseMutationSerial) {
        leases.delete(pane.sessionId);
      }
      render();
      deps.onStatus(deps.tr("status.terminalControlReleased"), "ok");
      return true;
    } catch (error) {
      console.debug("failed to release terminal control", error);
      deps.onStatus(deps.tr("status.terminalControlReleaseFailed"), "error");
      window.setTimeout(() => void syncActiveLease(), 0);
      return false;
    } finally {
      leaseMutationsInFlight = Math.max(0, leaseMutationsInFlight - 1);
    }
  }

  async function requestControlLease(pane: TerminalPane, reason: "attach" | "takeover") {
    const actor = currentTerminalControlActor();
    const serial = ++leaseMutationSerial;
    leaseMutationsInFlight += 1;
    try {
      const response = await deps.capabilityClient.requestControl({
        sessionId: pane.sessionId,
        actorId: actor.actorId,
        actorKind: actor.actorKind,
        reason,
      }, { timeoutMs: 5000 });
      if (reason === "takeover" && response.lease?.actorId !== actor.actorId) {
        throw new Error("takeover did not return a controller lease for this client");
      }
      if (serial === leaseMutationSerial) {
        rememberLease(pane.sessionId, response.lease);
      }
      return response.lease;
    } finally {
      leaseMutationsInFlight = Math.max(0, leaseMutationsInFlight - 1);
    }
  }

  async function syncActiveLease() {
    const pane = deps.activePane();
    if (!enabled() || !pane?.sessionId || syncInFlight || leaseMutationsInFlight > 0) return;
    syncInFlight = true;
    try {
      const syncSerial = leaseMutationSerial;
      const modeBefore = modeFor(pane);
      const response = await deps.capabilityClient.listSessions({
        selector: pane.selector,
      }, { timeoutMs: 5000 });
      if (syncSerial !== leaseMutationSerial || leaseMutationsInFlight > 0) return;
      const session = response.sessions.find((item) => item.id === pane.sessionId);
      rememberLease(pane.sessionId, session?.control);
      if (!activeLease(session?.control) && !releaseCooldownActive(pane.sessionId)) {
        await requestControlLease(pane, "attach");
      }
      if (modeBefore !== "controller" && modeFor(pane) === "controller") {
        deps.onTakeControlResize(pane);
      }
    } catch (error) {
      console.debug("failed to sync terminal control lease", error);
    } finally {
      syncInFlight = false;
      render();
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
    rememberLease(sessionId, lease);
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
        releaseControlTitle: deps.tr("action.releaseTerminalControl"),
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

  deps.overlayRoot.addEventListener("click", (event) => {
    const button = event.target instanceof Element
      ? event.target.closest<HTMLButtonElement>("[data-terminal-control-action='release-control']")
      : null;
    if (!button) return;
    event.preventDefault();
    void releaseControl();
  });

  window.setInterval(() => {
    void syncActiveLease();
  }, CONTROL_SYNC_INTERVAL_MS);

  return {
    enabled,
    prepareAttach,
    takeControl,
    releaseControl,
    isController,
    canWrite,
    noteLease,
    noteServerSize,
    noteLocalSize,
    handleRejectedWrite,
    render,
  };
}
