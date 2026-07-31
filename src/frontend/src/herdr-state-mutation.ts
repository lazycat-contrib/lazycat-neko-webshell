import type { HerdrSocketEnvelope, JsonRecord } from "./types.ts";
import { normalizeSelector } from "./workspace-selection.ts";

export type HerdrSocketRequestOptions = {
  selector?: string;
  id?: string;
  mirrorNotification?: boolean;
};

export function herdrStateMutationChangesVisibleTerminal(method: string): boolean {
  return method === "pane.focus"
    || method === "pane.split"
    || method === "pane.resize"
    || method === "pane.close";
}

type HerdrStateMutationRunnerDeps = {
  selectedSelector: () => string;
  selectedGeneration: () => number;
  request: (
    method: string,
    params: JsonRecord,
    options: HerdrSocketRequestOptions,
  ) => Promise<HerdrSocketEnvelope>;
  isCurrent: (selector: string, generation: number) => boolean;
  canMutate: (selector: string) => boolean;
  blockedError: () => Error;
  invalidate: () => void;
  reconcile: (method: string, selector: string) => void;
};

export function createHerdrStateMutationRunner(deps: HerdrStateMutationRunnerDeps) {
  return async function runHerdrStateMutation(
    method: string,
    params: JsonRecord = {},
    options: HerdrSocketRequestOptions = {},
  ): Promise<HerdrSocketEnvelope> {
    const selector = normalizeSelector(options.selector ?? deps.selectedSelector());
    const generation = deps.selectedGeneration();
    if (selector && !deps.canMutate(selector)) throw deps.blockedError();
    let envelope: HerdrSocketEnvelope;
    try {
      envelope = await deps.request(method, params, { ...options, selector });
    } catch (error) {
      if (deps.isCurrent(selector, generation)) {
        deps.invalidate();
        deps.reconcile(method, selector);
      }
      throw error;
    }
    if (deps.isCurrent(selector, generation)) deps.invalidate();
    return envelope;
  };
}
