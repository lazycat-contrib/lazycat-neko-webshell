import { normalizeSelector } from "./workspace-selection.ts";
import { createHerdrInteractionQueue, type HerdrInteractionRunner } from "./herdr-interaction-queue.ts";
import type { JsonRecord } from "./types.ts";

export type HerdrPaneFocusSocketRequest = {
  method: "agent.focus" | "pane.focus";
  params: JsonRecord;
  id: string;
};

export function herdrPaneFocusRequest(
  protocol: number | undefined,
  paneId: string,
): HerdrPaneFocusSocketRequest {
  if (protocol !== undefined && protocol < 16) {
    return {
      method: "agent.focus",
      params: { target: paneId },
      id: "lazycat-webshell:agent-focus",
    };
  }
  return {
    method: "pane.focus",
    params: { pane_id: paneId },
    id: "lazycat-webshell:pane-focus",
  };
}

type HerdrAgentFocusRequest = {
  selector: string;
  target: string;
};

type HerdrAgentActionsDeps = {
  selectedSelector: () => string;
  selectedGeneration: () => number;
  requestFocus: (request: HerdrAgentFocusRequest) => Promise<void>;
  isCurrent: (selector: string, generation: number) => boolean;
  runSerial?: HerdrInteractionRunner;
  onFocused: (selector: string, target: string) => void;
  onError: (error: unknown) => void;
};

export function createHerdrAgentActions(deps: HerdrAgentActionsDeps) {
  const defaultQueue = createHerdrInteractionQueue();
  const runSerial = deps.runSerial ?? ((task) => defaultQueue.runLatest("focus", task));
  return {
    async focus(paneId: string) {
      const target = paneId.trim();
      const selector = normalizeSelector(deps.selectedSelector());
      if (!target || !selector) return;
      const generation = deps.selectedGeneration();
      await runSerial(async () => {
        try {
          if (!deps.isCurrent(selector, generation)) return;
          await deps.requestFocus({ selector, target });
          if (deps.isCurrent(selector, generation)) deps.onFocused(selector, target);
        } catch (error) {
          if (deps.isCurrent(selector, generation)) deps.onError(error);
        }
      });
    },
  };
}
