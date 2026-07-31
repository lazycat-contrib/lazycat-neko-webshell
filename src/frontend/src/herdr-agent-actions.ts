import { normalizeSelector } from "./workspace-selection.ts";
import { createHerdrInteractionQueue, type HerdrInteractionRunner } from "./herdr-interaction-queue.ts";

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
  onFocused: (selector: string) => void;
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
          if (deps.isCurrent(selector, generation)) deps.onFocused(selector);
        } catch (error) {
          if (deps.isCurrent(selector, generation)) deps.onError(error);
        }
      });
    },
  };
}
