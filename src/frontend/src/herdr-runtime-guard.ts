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
  return {
    hidden: false,
    message: state.live_handoff_available
      ? tr("status.herdrServerOlder", values)
      : tr("status.herdrHandoffUnavailable", values),
    handoffVisible: state.live_handoff_available,
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

  async function performHandoff() {
    if (
      busy
      || confirming
      || uncertainHandoffs.has(selector)
      || !selector
      || !runtimeState?.live_handoff_available
    ) return;
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
      ) return;
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
            return;
          }
          uncertainHandoffs.add(requestSelector);
          void reconcileUncertainHandoff(requestSelector);
        } catch {
          uncertainHandoffs.add(requestSelector);
          void reconcileUncertainHandoff(requestSelector);
        }
      }
      options.onError(error instanceof Error ? error.message : String(error));
    } finally {
      if (operation === operationGeneration) {
        busy = false;
        confirming = false;
        render();
      }
    }
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
    clear,
  };
}
