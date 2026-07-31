import type { HerdrAction, HerdrBridgeState } from "./types.ts";
import { normalizeSelector } from "./workspace-selection.ts";

export type HerdrNavigationTarget = {
  kind: "workspace" | "tab" | "pane";
  id: string;
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
  ): Promise<boolean> {
    const selector = normalizeSelector(deps.selectedSelector());
    const generation = deps.selectedGeneration();
    if (!selector || !deps.currentState()?.available) return Promise.resolve(false);

    return deps.runSerial(async () => {
      if (!deps.isCurrent(selector, generation) || !deps.currentState()?.available) return false;
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
    focusWorkspace(workspaceId: string) {
      const id = workspaceId.trim();
      if (!id) return Promise.resolve(false);
      return navigate({ kind: "workspace", id }, "focus_workspace", { workspaceId: id });
    },
    focusTab(tabId: string) {
      const id = tabId.trim();
      if (!id) return Promise.resolve(false);
      return navigate({ kind: "tab", id }, "focus_tab", { tabId: id });
    },
    focusPane(paneId: string) {
      const id = paneId.trim();
      if (!id) return Promise.resolve(false);
      return navigate({ kind: "pane", id }, "focus_pane", { paneId: id });
    },
  };
}
