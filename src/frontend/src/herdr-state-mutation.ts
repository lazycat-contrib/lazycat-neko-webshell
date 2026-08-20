import type { HerdrSocketEnvelope, JsonRecord } from "./types.ts";
import { normalizeSelector } from "./workspace-selection.ts";

export type HerdrSocketRequestOptions = {
  selector?: string;
  id?: string;
  mirrorNotification?: boolean;
};

export type HerdrMutationTarget = {
  selector: string;
  generation: number;
};

export type HerdrStateMutationRequestOptions = HerdrSocketRequestOptions & {
  generation?: number;
};

export type HerdrStateMutationMethod =
  | "agent.start"
  | "pane.split"
  | "pane.resize"
  | "pane.close"
  | "tab.create"
  | "workspace.rename";

export function herdrStateMutationChangesVisibleTerminal(method: HerdrStateMutationMethod): boolean {
  return method === "pane.split"
    || method === "pane.resize"
    || method === "pane.close"
    || method === "tab.create";
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
  staleError: () => Error;
  invalidate: () => void;
  reconcile: (method: HerdrStateMutationMethod, selector: string) => void;
};

export function createHerdrStateMutationRunner(deps: HerdrStateMutationRunnerDeps) {
  return async function runHerdrStateMutation(
    method: HerdrStateMutationMethod,
    params: JsonRecord = {},
    options: HerdrStateMutationRequestOptions = {},
  ): Promise<HerdrSocketEnvelope> {
    const selector = normalizeSelector(options.selector ?? deps.selectedSelector());
    const generation = options.generation ?? deps.selectedGeneration();
    if (!selector || !deps.isCurrent(selector, generation)) throw deps.staleError();
    if (selector && !deps.canMutate(selector)) throw deps.blockedError();
    const { generation: _generation, ...requestOptions } = options;
    let envelope: HerdrSocketEnvelope;
    try {
      envelope = await deps.request(method, params, { ...requestOptions, selector });
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
