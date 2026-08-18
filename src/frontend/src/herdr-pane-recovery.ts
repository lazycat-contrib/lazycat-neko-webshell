import type { HerdrRuntimeGuardState, SessionBackendId } from "./types";

export type HerdrPaneRecoveryState = {
  id: string;
  workspacePaneId?: string;
  selector: string;
  sessionId?: string;
  sessionStatus?: string;
  sessionBackend: SessionBackendId;
  processExitObserved?: boolean;
  exited?: boolean;
  closing?: boolean;
};

export type HerdrPaneRecoveryRef = {
  recoveryId: string;
  paneId: string;
};

export function herdrHandoffCandidatePanes(
  panes: readonly HerdrPaneRecoveryState[],
  selector: string,
): HerdrPaneRecoveryRef[] {
  const target = selector.trim();
  if (!target) return [];
  return panes
    .filter((pane) => (
      pane.selector.trim() === target
      && pane.sessionBackend === "herdr"
      && Boolean(pane.sessionId)
      && Boolean(pane.workspacePaneId)
      && pane.processExitObserved !== true
      && pane.exited !== true
      && pane.closing !== true
      && (pane.sessionStatus === "running" || pane.sessionStatus === "starting")
    ))
    .map((pane) => ({
      recoveryId: pane.id,
      paneId: pane.workspacePaneId ?? "",
    }));
}

export function herdrHandoffCandidatePaneIds(
  panes: readonly HerdrPaneRecoveryState[],
  selector: string,
): string[] {
  return herdrHandoffCandidatePanes(panes, selector).map((pane) => pane.recoveryId);
}

export function herdrWorkspacePaneIds(
  panes: readonly HerdrPaneRecoveryState[],
  selector: string,
): Set<string> {
  const target = selector.trim();
  return new Set(panes
    .filter((pane) => (
      target
      && pane.selector.trim() === target
      && pane.sessionBackend === "herdr"
      && Boolean(pane.workspacePaneId)
    ))
    .map((pane) => pane.workspacePaneId ?? ""));
}

export function herdrPaneRecoveryIds(
  panes: readonly HerdrPaneRecoveryState[],
  selector: string,
  eligiblePaneIds: ReadonlySet<string>,
): string[] {
  const target = selector.trim();
  if (!target) return [];
  return panes
    .filter((pane) => (
      pane.selector.trim() === target
      && pane.sessionBackend === "herdr"
      && Boolean(pane.sessionId)
      && pane.processExitObserved === true
      && pane.closing !== true
      && eligiblePaneIds.has(pane.id)
    ))
    .map((pane) => pane.id);
}

export type HerdrRecoverablePaneState = HerdrPaneRecoveryState;

export function recoverHerdrPaneStatesAfterHandoff<T extends HerdrRecoverablePaneState>(
  panes: readonly T[],
  selector: string,
  eligiblePaneIds: ReadonlySet<string>,
  reconnect: (pane: T) => void,
): string[] {
  const recoverableIds = new Set(herdrPaneRecoveryIds(panes, selector, eligiblePaneIds));
  for (const pane of panes) {
    if (!recoverableIds.has(pane.id)) continue;
    pane.processExitObserved = false;
    pane.exited = false;
    pane.sessionStatus = "stopped";
    reconnect(pane);
  }
  return [...recoverableIds];
}

export function herdrExitShouldRemainRecoverable(state: HerdrRuntimeGuardState): boolean {
  return state.state === "client_older"
    || state.state === "server_older"
    || state.state === "unknown";
}

type HerdrExitedPaneTarget = {
  selector: string;
  paneId: string;
  recoveryId: string;
  exitCode?: number;
};

type PaneRefMap = Map<string, Map<string, string>>;

export function createHerdrExitRecovery(options: {
  fetchStatus: (selector: string) => Promise<HerdrRuntimeGuardState>;
  cleanup: (target: HerdrExitedPaneTarget) => void | Promise<void>;
  recover: (selector: string) => void | Promise<void>;
  retry?: (target: HerdrExitedPaneTarget) => void;
  now?: () => number;
  handoffSettlementMs?: number;
  recoveryProtectionMs?: number;
  pendingHandoffMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  handoffStatusAttempts?: number;
  handoffStatusDelayMs?: number;
}) {
  const now = options.now ?? Date.now;
  const handoffSettlementMs = options.handoffSettlementMs ?? 30_000;
  const recoveryProtectionMs = options.recoveryProtectionMs ?? 120_000;
  const pendingHandoffMs = options.pendingHandoffMs ?? 120_000;
  const wait = options.wait ?? ((delayMs: number) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)));
  const handoffStatusAttempts = options.handoffStatusAttempts ?? 40;
  const handoffStatusDelayMs = options.handoffStatusDelayMs ?? 250;
  const recoverablePanes: PaneRefMap = new Map();
  const recoverablePaneExpiresAt = new Map<string, Map<string, number>>();
  const removablePanes: PaneRefMap = new Map();
  const pendingHandoffPanes: PaneRefMap = new Map();
  const pendingHandoffExpiresAt = new Map<string, number>();
  const committedHandoffPanes: PaneRefMap = new Map();
  const committedHandoffExpiresAt = new Map<string, number>();
  const pendingStatus = new Map<string, Promise<HerdrRuntimeGuardState>>();

  function beginHandoff(selector: string, panes: Iterable<HerdrPaneRecoveryRef>) {
    const target = selector.trim();
    if (!target) return;
    const refs = new Map<string, string>();
    for (const pane of panes) {
      if (pane.recoveryId && pane.paneId) {
        refs.set(pane.recoveryId, pane.paneId);
        deletePaneId(removablePanes, target, pane.recoveryId);
      }
    }
    pendingHandoffPanes.set(target, refs);
    pendingHandoffExpiresAt.set(target, now() + pendingHandoffMs);
  }

  function noteHandoff(selector: string) {
    const target = selector.trim();
    const pending = pendingHandoffPanes.get(target);
    pendingHandoffPanes.delete(target);
    pendingHandoffExpiresAt.delete(target);
    if (!pending?.size) return;
    const committed = committedHandoffPanes.get(target) ?? new Map<string, string>();
    for (const [recoveryId, paneId] of pending) committed.set(recoveryId, paneId);
    committedHandoffPanes.set(target, committed);
    committedHandoffExpiresAt.set(target, now() + handoffSettlementMs);
  }

  function failHandoff(selector: string) {
    const target = selector.trim();
    pendingHandoffPanes.delete(target);
    pendingHandoffExpiresAt.delete(target);
  }

  function deletePaneId(map: PaneRefMap, selector: string, recoveryId: string) {
    const panes = map.get(selector);
    if (!panes) return;
    panes.delete(recoveryId);
    if (!panes.size) map.delete(selector);
  }

  function notePaneReady(selector: string, paneId: string) {
    const target = selector.trim();
    deletePaneId(pendingHandoffPanes, target, paneId);
    if (!pendingHandoffPanes.has(target)) pendingHandoffExpiresAt.delete(target);
    deletePaneId(committedHandoffPanes, target, paneId);
    if (!committedHandoffPanes.has(target)) committedHandoffExpiresAt.delete(target);
    deleteRecoverablePaneId(target, paneId);
    deletePaneId(removablePanes, target, paneId);
  }

  function markRecoverable(target: HerdrExitedPaneTarget) {
    const selector = target.selector.trim();
    if (!selector || !target.recoveryId || !target.paneId) return;
    const panes = recoverablePanes.get(selector) ?? new Map<string, string>();
    panes.set(target.recoveryId, target.paneId);
    recoverablePanes.set(selector, panes);
    const expirations = recoverablePaneExpiresAt.get(selector) ?? new Map<string, number>();
    expirations.set(target.recoveryId, now() + recoveryProtectionMs);
    recoverablePaneExpiresAt.set(selector, expirations);
    deletePaneId(removablePanes, selector, target.recoveryId);
  }

  function recoverablePaneIds(selector: string): string[] {
    const target = selector.trim();
    expireRecoverablePanes(target);
    return [...(recoverablePanes.get(target)?.keys() ?? [])];
  }

  function protectedWorkspacePaneIds(selector: string): Set<string> {
    const target = selector.trim();
    expireRecoverablePanes(target);
    expireHandoffPanes(target);
    const protectedIds = new Set<string>();
    for (const refs of [
      recoverablePanes.get(target),
      pendingHandoffPanes.get(target),
      committedHandoffPanes.get(target),
    ]) {
      if (!refs) continue;
      for (const paneId of refs.values()) protectedIds.add(paneId);
    }
    return protectedIds;
  }

  function expireHandoffPanes(selector: string) {
    const pendingExpiresAt = pendingHandoffExpiresAt.get(selector);
    if (pendingExpiresAt !== undefined && now() > pendingExpiresAt) {
      pendingHandoffPanes.delete(selector);
      pendingHandoffExpiresAt.delete(selector);
    }
    const expiresAt = committedHandoffExpiresAt.get(selector);
    if (expiresAt !== undefined && now() > expiresAt) {
      committedHandoffPanes.delete(selector);
      committedHandoffExpiresAt.delete(selector);
    }
  }

  function isTrackedHandoffPane(target: HerdrExitedPaneTarget): boolean {
    const selector = target.selector.trim();
    expireHandoffPanes(selector);
    return [pendingHandoffPanes, committedHandoffPanes].some((panes) => (
      panes.get(selector)?.get(target.recoveryId) === target.paneId
    ));
  }

  function removableWorkspacePaneIds(selector: string): Set<string> {
    return new Set(removablePanes.get(selector.trim())?.values() ?? []);
  }

  function expireRecoverablePanes(selector: string) {
    const expirations = recoverablePaneExpiresAt.get(selector);
    if (!expirations) return;
    for (const [recoveryId, expiresAt] of expirations) {
      if (now() <= expiresAt) continue;
      expirations.delete(recoveryId);
      const paneId = recoverablePanes.get(selector)?.get(recoveryId);
      if (paneId) {
        const removable = removablePanes.get(selector) ?? new Map<string, string>();
        removable.set(recoveryId, paneId);
        removablePanes.set(selector, removable);
      }
      deletePaneId(recoverablePanes, selector, recoveryId);
    }
    if (!expirations.size) recoverablePaneExpiresAt.delete(selector);
  }

  function deleteRecoverablePaneId(selector: string, recoveryId: string) {
    deletePaneId(recoverablePanes, selector, recoveryId);
    const expirations = recoverablePaneExpiresAt.get(selector);
    expirations?.delete(recoveryId);
    if (expirations && !expirations.size) recoverablePaneExpiresAt.delete(selector);
  }

  function markRemovable(target: HerdrExitedPaneTarget) {
    const selector = target.selector.trim();
    if (!selector || !target.recoveryId || !target.paneId) return;
    deleteRecoverablePaneId(selector, target.recoveryId);
    const panes = removablePanes.get(selector) ?? new Map<string, string>();
    panes.set(target.recoveryId, target.paneId);
    removablePanes.set(selector, panes);
  }

  async function cleanupOrdinary(target: HerdrExitedPaneTarget) {
    markRemovable(target);
    await options.cleanup(target);
  }

  function fetchStatus(selector: string): Promise<HerdrRuntimeGuardState> {
    const target = selector.trim();
    const current = pendingStatus.get(target);
    if (current) return current;
    const request = options.fetchStatus(target).finally(() => {
      if (pendingStatus.get(target) === request) pendingStatus.delete(target);
    });
    pendingStatus.set(target, request);
    return request;
  }

  async function handle(target: HerdrExitedPaneTarget) {
    if (target.exitCode !== 1) {
      await cleanupOrdinary(target);
      return;
    }
    let lastState: HerdrRuntimeGuardState | undefined;
    for (let attempt = 0; attempt < handoffStatusAttempts; attempt += 1) {
      try {
        lastState = await fetchStatus(target.selector);
        if (lastState.handoff_recent) {
          markRecoverable(target);
          if (lastState.state === "ready") {
            await options.recover(target.selector);
            return;
          }
        } else if (isTrackedHandoffPane(target)) {
          // A provider restart or lost response can erase its in-memory handoff
          // marker after Herdr has already committed. The selector-scoped,
          // pane-exact, bounded browser candidate is trusted only for recovery.
          markRecoverable(target);
          if (lastState.state === "ready") {
            await options.recover(target.selector);
          }
          return;
        } else if (herdrExitShouldRemainRecoverable(lastState)) {
          const firstRecovery = !recoverablePanes.get(target.selector.trim())?.has(target.recoveryId);
          markRecoverable(target);
          if (firstRecovery) options.retry?.(target);
          return;
        } else {
          await cleanupOrdinary(target);
          return;
        }
      } catch {
        // Runtime inspection can fail briefly while a handoff replaces the target socket.
      }
      if (attempt + 1 < handoffStatusAttempts) await wait(handoffStatusDelayMs);
    }
    if (!lastState || lastState.handoff_recent) {
      markRecoverable(target);
      return;
    }
    await cleanupOrdinary(target);
  }

  return {
    handle,
    beginHandoff,
    noteHandoff,
    failHandoff,
    notePaneReady,
    recoverablePaneIds,
    protectedWorkspacePaneIds,
    removableWorkspacePaneIds,
  };
}
