import type { HerdrSocketEnvelope } from "./types";

export type HerdrEventStreamDecision = {
  presentEvent: boolean;
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

    // Herdr 0.7.x subscriptions replay each event kind independently and do
    // not expose a replay cursor or completion marker. Treating the stream as
    // an invalidation feed keeps delayed history from mutating visible state.
    handle(envelope: HerdrSocketEnvelope): HerdrEventStreamDecision {
      token += 1;
      const presentEvent = envelope.event === "pane.agent_status_changed";
      if (!active) {
        return {
          presentEvent: false,
          requestReconcile: false,
          token,
        };
      }
      return {
        presentEvent,
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
