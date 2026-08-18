import type { MessageKey } from "./i18n";
import type { HerdrBridgeState, HerdrRuntimeGuardState } from "./types";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type GuardElements = {
  root: HTMLElement;
  message: HTMLElement;
  handoff: HTMLButtonElement;
};

type GuardOptions = {
  elements: GuardElements;
  tr: Translate;
  fetchStatus: (selector: string) => Promise<HerdrRuntimeGuardState>;
  handoff: (selector: string) => Promise<HerdrRuntimeGuardState>;
  confirm: (request: {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
  }) => Promise<boolean>;
  onHandoffStart?: (selector: string) => void;
  onHandoffFailed?: (selector: string) => void;
  onRecovered: (selector: string) => void | Promise<void>;
  onError: (message: string) => void;
  wait?: (delayMs: number) => Promise<void>;
  uncertainReconcileAttempts?: number;
  uncertainReconcileDelayMs?: number;
  uncertainReconcileWindowMs?: number;
  now?: () => number;
};

export type HerdrRuntimeGuardPresentation = {
  hidden: boolean;
  message: string;
  handoffVisible: boolean;
};

export type HerdrTerminalPreparation = {
  ready: boolean;
  retry: boolean;
};

function canLiveHandoff(state: HerdrRuntimeGuardState | undefined): state is HerdrRuntimeGuardState {
  return state?.state === "server_older"
    && state.live_handoff_available
    && Number.isSafeInteger(state.client_protocol)
    && Number.isSafeInteger(state.server_protocol)
    && state.server_protocol !== undefined
    && state.client_protocol > state.server_protocol;
}

export function herdrRuntimeGuardPresentation(
  state: HerdrRuntimeGuardState | undefined,
  tr: Translate,
): HerdrRuntimeGuardPresentation {
  if (!state || state.state === "ready" || state.state === "not_running") {
    return { hidden: true, message: "", handoffVisible: false };
  }
  if (state.handoff_recent) {
    return {
      hidden: false,
      message: tr("status.herdrHandoffRunning"),
      handoffVisible: false,
    };
  }
  const values = {
    client: state.client_protocol,
    server: state.server_protocol ?? "?",
  };
  if (state.state === "client_older") {
    return {
      hidden: false,
      message: tr("status.herdrClientOlder", values),
      handoffVisible: false,
    };
  }
  if (state.state === "unknown") {
    return {
      hidden: false,
      message: tr("status.herdrProtocolUnknown"),
      handoffVisible: false,
    };
  }
  const handoffAvailable = canLiveHandoff(state);
  return {
    hidden: false,
    message: handoffAvailable
      ? tr("status.herdrServerOlder", values)
      : tr("status.herdrHandoffUnavailable", values),
    handoffVisible: handoffAvailable,
  };
}

export function createHerdrRuntimeGuard(options: GuardOptions) {
  let selector = "";
  let requestKey = "";
  let requestGeneration = 0;
  let operationGeneration = 0;
  let runtimeState: HerdrRuntimeGuardState | undefined;
  let busy = false;
  let confirming = false;
  const terminalPreparations = new Map<string, Promise<HerdrTerminalPreparation>>();
  const uncertainHandoffs = new Set<string>();
  const wait = options.wait
    ?? ((delayMs: number) => new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)));
  const uncertainReconcileAttempts = options.uncertainReconcileAttempts ?? 100;
  const uncertainReconcileDelayMs = options.uncertainReconcileDelayMs ?? 1_000;
  const uncertainReconcileWindowMs = options.uncertainReconcileWindowMs ?? 95_000;
  const now = options.now ?? Date.now;

  options.elements.handoff.addEventListener("click", () => void performHandoff());

  function sync(nextSelector: string, bridgeState: HerdrBridgeState | undefined) {
    const normalized = nextSelector.trim();
    if (!normalized || !bridgeState) {
      clear();
      return;
    }
    if (normalized !== selector) {
      operationGeneration += 1;
      busy = false;
      confirming = false;
      runtimeState = undefined;
      render();
    }
    selector = normalized;
    const nextKey = [
      selector,
      bridgeState.herdr_version ?? "",
      bridgeState.herdr_protocol ?? "",
    ].join(":");
    if (nextKey === requestKey) return;
    requestKey = nextKey;
    void refresh();
  }

  async function refresh() {
    if (!selector) return;
    const requestSelector = selector;
    const generation = ++requestGeneration;
    runtimeState = undefined;
    render();
    try {
      const state = await options.fetchStatus(requestSelector);
      if (generation !== requestGeneration || requestSelector !== selector) return;
      runtimeState = state;
      render();
      if (uncertainHandoffs.has(requestSelector)) {
        if (state.state === "ready" && uncertainHandoffs.delete(requestSelector)) {
          await options.onRecovered(requestSelector);
        } else if (state.state === "client_older" && uncertainHandoffs.delete(requestSelector)) {
          options.onHandoffFailed?.(requestSelector);
        }
      }
    } catch (error) {
      if (generation !== requestGeneration || requestSelector !== selector) return;
      runtimeState = undefined;
      render();
      options.onError(error instanceof Error ? error.message : String(error));
    }
  }

  async function performHandoff(): Promise<boolean> {
    if (
      busy
      || confirming
      || uncertainHandoffs.has(selector)
      || !selector
      || !canLiveHandoff(runtimeState)
    ) return false;
    const requestSelector = selector;
    const requestState = runtimeState;
    const statusGeneration = requestGeneration;
    const operation = ++operationGeneration;
    let handoffStarted = false;
    let handoffCommitted = false;
    confirming = true;
    render();
    try {
      const confirmed = await options.confirm({
        title: options.tr("status.herdrHandoffTitle"),
        message: options.tr("status.herdrHandoffConfirm"),
        confirmLabel: options.tr("action.herdrLiveHandoff"),
        cancelLabel: options.tr("action.cancel"),
      });
      if (
        !confirmed
        || operation !== operationGeneration
        || requestSelector !== selector
        || requestState !== runtimeState
        || statusGeneration !== requestGeneration
      ) return false;
      confirming = false;
      busy = true;
      requestGeneration += 1;
      handoffStarted = true;
      options.onHandoffStart?.(requestSelector);
      render();
      const nextState = await options.handoff(requestSelector);
      handoffCommitted = true;
      const operationIsCurrent = operation === operationGeneration && requestSelector === selector;
      if (operationIsCurrent) {
        requestGeneration += 1;
        runtimeState = nextState;
        requestKey = "";
        render();
      }
      await options.onRecovered(requestSelector);
      return true;
    } catch (error) {
      if (handoffStarted && !handoffCommitted) {
        try {
          const reconciled = await options.fetchStatus(requestSelector);
          if (reconciled.state === "ready") {
            handoffCommitted = true;
            uncertainHandoffs.delete(requestSelector);
            if (operation === operationGeneration && requestSelector === selector) {
              requestGeneration += 1;
              runtimeState = reconciled;
              requestKey = "";
              render();
            }
            await options.onRecovered(requestSelector);
            return true;
          }
          uncertainHandoffs.add(requestSelector);
          void reconcileUncertainHandoff(requestSelector);
        } catch {
          uncertainHandoffs.add(requestSelector);
          void reconcileUncertainHandoff(requestSelector);
        }
      }
      options.onError(error instanceof Error ? error.message : String(error));
      return false;
    } finally {
      if (operation === operationGeneration) {
        busy = false;
        confirming = false;
        render();
      }
    }
  }

  function publishTerminalRuntimeState(
    requestSelector: string,
    state: HerdrRuntimeGuardState,
  ) {
    if (requestSelector !== selector) return;
    requestGeneration += 1;
    runtimeState = state;
    requestKey = "";
    render();
  }

  async function prepareTerminalOnce(
    requestSelector: string,
  ): Promise<HerdrTerminalPreparation> {
    let state: HerdrRuntimeGuardState;
    try {
      state = await options.fetchStatus(requestSelector);
      publishTerminalRuntimeState(requestSelector, state);
    } catch (error) {
      options.onError(error instanceof Error ? error.message : String(error));
      return { ready: false, retry: true };
    }
    if (state.state === "ready" || state.state === "not_running") {
      return { ready: true, retry: false };
    }
    if (
      state.handoff_recent
      || busy
      || confirming
      || uncertainHandoffs.has(requestSelector)
    ) {
      return { ready: false, retry: true };
    }
    if (!canLiveHandoff(state)) {
      const presentation = herdrRuntimeGuardPresentation(state, options.tr);
      if (presentation.message) options.onError(presentation.message);
      return { ready: false, retry: false };
    }
    if (requestSelector !== selector) return { ready: false, retry: true };

    let handoffStarted = false;
    const operation = ++operationGeneration;
    confirming = true;
    render();
    try {
      const confirmed = await options.confirm({
        title: options.tr("status.herdrHandoffTitle"),
        message: options.tr("status.herdrHandoffConfirm"),
        confirmLabel: options.tr("action.herdrLiveHandoff"),
        cancelLabel: options.tr("action.cancel"),
      });
      if (operation !== operationGeneration || requestSelector !== selector) {
        return { ready: false, retry: true };
      }
      if (!confirmed) return { ready: false, retry: false };

      const validated = await options.fetchStatus(requestSelector);
      publishTerminalRuntimeState(requestSelector, validated);
      if (operation !== operationGeneration || requestSelector !== selector) {
        return { ready: false, retry: true };
      }
      if (validated.state === "ready" || validated.state === "not_running") {
        return { ready: true, retry: false };
      }
      if (validated.handoff_recent) return { ready: false, retry: true };
      if (
        !canLiveHandoff(validated)
        || validated.client_protocol !== state.client_protocol
        || validated.server_protocol !== state.server_protocol
      ) {
        return { ready: false, retry: false };
      }
      confirming = false;
      busy = true;
      handoffStarted = true;
      render();
      options.onHandoffStart?.(requestSelector);
      const nextState = await options.handoff(requestSelector);
      publishTerminalRuntimeState(requestSelector, nextState);
      if (nextState.state !== "ready") {
        options.onHandoffFailed?.(requestSelector);
        return { ready: false, retry: true };
      }
      await options.onRecovered(requestSelector);
      return { ready: true, retry: false };
    } catch (error) {
      if (handoffStarted) {
        try {
          const reconciled = await options.fetchStatus(requestSelector);
          publishTerminalRuntimeState(requestSelector, reconciled);
          if (reconciled.state === "ready") {
            await options.onRecovered(requestSelector);
            return { ready: true, retry: false };
          }
        } catch {
          // The pane retry path will inspect the runtime again.
        }
        uncertainHandoffs.add(requestSelector);
        void reconcileUncertainHandoff(requestSelector);
      }
      options.onError(error instanceof Error ? error.message : String(error));
      return { ready: false, retry: true };
    } finally {
      if (operation === operationGeneration) {
        confirming = false;
        if (handoffStarted) busy = false;
        render();
      }
    }
  }

  function prepareTerminal(
    nextSelector: string,
    activeTarget = false,
  ): Promise<HerdrTerminalPreparation> {
    const normalized = nextSelector.trim();
    if (!normalized) return Promise.resolve({ ready: false, retry: false });
    if (activeTarget && normalized !== selector) {
      operationGeneration += 1;
      busy = false;
      confirming = false;
      runtimeState = undefined;
      requestKey = "";
      selector = normalized;
      render();
    }
    const existing = terminalPreparations.get(normalized);
    if (existing) return existing;
    const preparation = prepareTerminalOnce(normalized)
      .finally(() => terminalPreparations.delete(normalized));
    terminalPreparations.set(normalized, preparation);
    return preparation;
  }

  async function reconcileUncertainHandoff(requestSelector: string) {
    const deadline = now() + uncertainReconcileWindowMs;
    for (let attempt = 0; attempt < uncertainReconcileAttempts; attempt += 1) {
      if (!uncertainHandoffs.has(requestSelector)) return;
      try {
        const state = await options.fetchStatus(requestSelector);
        if (requestSelector === selector) {
          requestGeneration += 1;
          runtimeState = state;
          requestKey = "";
          render();
        }
        if (state.state === "ready" || state.state === "client_older") {
          if (!uncertainHandoffs.delete(requestSelector)) return;
          try {
            if (state.state === "ready") {
              await options.onRecovered(requestSelector);
            } else {
              options.onHandoffFailed?.(requestSelector);
            }
          } catch (error) {
            options.onError(error instanceof Error ? error.message : String(error));
          }
          if (requestSelector === selector) render();
          return;
        }
        if (attempt + 1 < uncertainReconcileAttempts && now() < deadline) {
          await wait(Math.min(uncertainReconcileDelayMs, deadline - now()));
        }
      } catch {
        if (attempt + 1 < uncertainReconcileAttempts && now() < deadline) {
          await wait(Math.min(uncertainReconcileDelayMs, deadline - now()));
        }
      }
      if (now() >= deadline) break;
    }
    if (uncertainHandoffs.delete(requestSelector)) {
      try {
        options.onHandoffFailed?.(requestSelector);
      } catch (error) {
        options.onError(error instanceof Error ? error.message : String(error));
      }
      if (requestSelector === selector) render();
    }
  }

  function render() {
    const presentation = herdrRuntimeGuardPresentation(runtimeState, options.tr);
    const reconciling = uncertainHandoffs.has(selector);
    options.elements.root.hidden = presentation.hidden && !reconciling;
    options.elements.message.textContent = busy || reconciling
      ? options.tr("status.herdrHandoffRunning")
      : presentation.message;
    options.elements.handoff.hidden = !presentation.handoffVisible;
    options.elements.handoff.disabled = busy || confirming || reconciling;
  }

  function clear() {
    requestGeneration += 1;
    operationGeneration += 1;
    selector = "";
    requestKey = "";
    runtimeState = undefined;
    busy = false;
    confirming = false;
    render();
  }

  return {
    sync,
    refresh,
    prepareTerminal,
    clear,
  };
}
