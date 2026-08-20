import type { HerdrAction, HerdrBridgeState } from "./types.ts";
import { normalizeSelector } from "./workspace-selection.ts";

export type HerdrNavigationTarget = {
  kind: "workspace" | "tab" | "pane";
  id: string;
};

export type HerdrNavigationContext = {
  selector: string;
  generation: number;
  paneId?: string;
  sessionId?: string;
};

type HerdrNavigationOptions = {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
};

type HerdrNavigationRunner = <T>(task: () => Promise<T>) => Promise<T>;

type HerdrNavigationDeps = {
  selectedSelector: () => string;
  selectedGeneration: () => number;
  currentState: () => HerdrBridgeState | undefined;
  isCurrent: (selector: string, generation: number) => boolean;
  canNavigate: (selector: string, context?: HerdrNavigationContext) => boolean;
  request: (
    selector: string,
    action: HerdrAction,
    options: HerdrNavigationOptions,
  ) => Promise<HerdrBridgeState>;
  runSerial: HerdrNavigationRunner;
  applyState: (state: HerdrBridgeState) => void;
  invalidate: () => void;
  onSettled: (selector: string, target: HerdrNavigationTarget) => void;
  onError: (error: unknown) => void;
};

export function createHerdrNavigationController(deps: HerdrNavigationDeps) {
  function navigate(
    target: HerdrNavigationTarget,
    action: HerdrAction,
    options: HerdrNavigationOptions,
    context?: HerdrNavigationContext,
  ): Promise<boolean> {
    const selector = normalizeSelector(context?.selector ?? deps.selectedSelector());
    const generation = context?.generation ?? deps.selectedGeneration();
    if (
      !selector
      || !deps.isCurrent(selector, generation)
      || !deps.currentState()?.available
      || !deps.canNavigate(selector, context)
    ) {
      return Promise.resolve(false);
    }

    return deps.runSerial(async () => {
      if (
        !deps.isCurrent(selector, generation)
        || !deps.currentState()?.available
        || !deps.canNavigate(selector, context)
      ) return false;
      deps.invalidate();
      try {
        const state = await deps.request(selector, action, options);
        if (!deps.isCurrent(selector, generation)) return false;
        deps.invalidate();
        deps.applyState(state);
        deps.onSettled(selector, target);
        return state.available;
      } catch (error) {
        if (deps.isCurrent(selector, generation)) {
          deps.onError(error);
          deps.onSettled(selector, target);
        }
        return false;
      }
    });
  }

  return {
    focusWorkspace(workspaceId: string, context?: HerdrNavigationContext) {
      const id = workspaceId.trim();
      if (!id) return Promise.resolve(false);
      return navigate({ kind: "workspace", id }, "focus_workspace", { workspaceId: id }, context);
    },
    focusTab(tabId: string, context?: HerdrNavigationContext) {
      const id = tabId.trim();
      if (!id) return Promise.resolve(false);
      return navigate({ kind: "tab", id }, "focus_tab", { tabId: id }, context);
    },
    focusPane(paneId: string, context?: HerdrNavigationContext) {
      const id = paneId.trim();
      if (!id) return Promise.resolve(false);
      return navigate({ kind: "pane", id }, "focus_pane", { paneId: id }, context);
    },
  };
}
