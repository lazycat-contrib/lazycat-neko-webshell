import type { HerdrSocketEnvelope } from "./types";

export type HerdrEventStreamDecision = {
  requestReconcile: boolean;
  token: number;
};

export type HerdrEventStreamReconciliation = {
  current: boolean;
  resubscribe: boolean;
};

function normalizedPaneIds(paneIds: readonly string[]): string[] {
  return [...new Set(paneIds.filter(Boolean))].sort();
}

function samePaneIds(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = normalizedPaneIds(left);
  const normalizedRight = normalizedPaneIds(right);
  return normalizedLeft.length === normalizedRight.length
    && normalizedLeft.every((paneId, index) => paneId === normalizedRight[index]);
}

const REFRESH_RETRY_DELAYS_MS = [300, 900, 1800, 5000] as const;

export function herdrEventBridgeShouldSubscribe(selector: string, available: boolean): boolean {
  return Boolean(selector && available);
}

export function recoverHerdrEventStream(envelope: HerdrSocketEnvelope, recover: () => void): boolean {
  if (envelope.error?.code !== "events_lost" && envelope.error?.code !== "pane_not_found") return false;
  recover();
  return true;
}

export function createHerdrEventStreamPolicy() {
  let active = false;
  let token = 0;
  let subscribedPaneIds: string[] = [];

  return {
    beginSubscription(paneIds: readonly string[]) {
      active = true;
      subscribedPaneIds = normalizedPaneIds(paneIds);
      token += 1;
    },

    // Retained history and repeated status/presentation events are invalidations,
    // not new notifications. Reconcile the authoritative snapshot before alerting.
    handle(_envelope: HerdrSocketEnvelope): HerdrEventStreamDecision {
      token += 1;
      if (!active) {
        return {
          requestReconcile: false,
          token,
        };
      }
      return {
        requestReconcile: true,
        token,
      };
    },

    reconciled(
      reconciliationToken: number,
      authoritativePaneIds: readonly string[],
    ): HerdrEventStreamReconciliation {
      if (!active || reconciliationToken !== token) {
        return { current: false, resubscribe: false };
      }
      if (!samePaneIds(subscribedPaneIds, authoritativePaneIds)) {
        return { current: true, resubscribe: true };
      }
      return { current: true, resubscribe: false };
    },

    isCurrent(reconciliationToken: number): boolean {
      return active && reconciliationToken === token;
    },

    retryDelay(reconciliationToken: number, attempt: number): number | undefined {
      if (!active || reconciliationToken !== token) return undefined;
      const index = Math.min(
        Math.max(0, Math.trunc(attempt)),
        REFRESH_RETRY_DELAYS_MS.length - 1,
      );
      return REFRESH_RETRY_DELAYS_MS[index];
    },

    reset() {
      active = false;
      subscribedPaneIds = [];
      token += 1;
    },
  };
}
