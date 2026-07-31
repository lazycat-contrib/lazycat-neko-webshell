import {
  applyHerdrPaneFocus,
  applyHerdrTabFocus,
  applyHerdrWorkspaceFocus,
  type HerdrResourceEventResult,
} from "./herdr-state-events.ts";
import type { HerdrBridgeState, HerdrSocketEnvelope, JsonRecord } from "./types.ts";
import { normalizeSelector } from "./workspace-selection.ts";

export type HerdrNavigationTarget = {
  kind: "workspace" | "tab" | "pane";
  id: string;
};

type HerdrNavigationRequest = {
  method: "workspace.focus" | "tab.focus" | "agent.focus" | "pane.focus";
  params: JsonRecord;
  id: string;
};

type HerdrNavigationDeps = {
  selectedSelector: () => string;
  selectedGeneration: () => number;
  currentState: () => HerdrBridgeState | undefined;
  isCurrent: (selector: string, generation: number) => boolean;
  request: (
    method: string,
    params: JsonRecord,
    options: { selector: string; id: string; mirrorNotification: false },
  ) => Promise<HerdrSocketEnvelope>;
  applyState: (state: HerdrBridgeState) => void;
  invalidate: () => void;
  onSettled: (selector: string, target: HerdrNavigationTarget) => void;
  onError: (error: unknown) => void;
};

function paneFocusRequest(state: HerdrBridgeState, paneId: string): HerdrNavigationRequest | undefined {
  const pane = state.panes.find((item) => item.pane_id === paneId);
  if (!pane) return undefined;
  const tab = state.tabs.find((item) => item.tab_id === pane.tab_id);
  const knownPaneCount = state.panes.filter((item) => item.tab_id === pane.tab_id).length;
  if (knownPaneCount <= 1 && (tab?.pane_count ?? knownPaneCount) <= 1) {
    return {
      method: "tab.focus",
      params: { tab_id: pane.tab_id },
      id: "lazycat-webshell:tab-focus",
    };
  }
  if (state.herdr_protocol !== undefined && state.herdr_protocol < 16) {
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

export function createHerdrNavigationController(deps: HerdrNavigationDeps) {
  let latestIntent = 0;

  async function navigate(
    target: HerdrNavigationTarget,
    requestForState: (state: HerdrBridgeState) => HerdrNavigationRequest | undefined,
    transition: (state: HerdrBridgeState) => HerdrResourceEventResult,
  ): Promise<boolean> {
    const selector = normalizeSelector(deps.selectedSelector());
    const generation = deps.selectedGeneration();
    const state = deps.currentState();
    if (!selector || !state?.available || !deps.isCurrent(selector, generation)) return false;
    const request = requestForState(state);
    const optimistic = transition(state);
    if (!request || !optimistic.applied) return false;

    const intent = ++latestIntent;
    deps.invalidate();
    deps.applyState(optimistic.state);

    try {
      await deps.request(request.method, request.params, {
        selector,
        id: request.id,
        mirrorNotification: false,
      });
      if (intent !== latestIntent || !deps.isCurrent(selector, generation)) return false;
      deps.onSettled(selector, target);
      return true;
    } catch (error) {
      if (intent === latestIntent && deps.isCurrent(selector, generation)) {
        deps.onError(error);
        deps.onSettled(selector, target);
      }
      return false;
    }
  }

  return {
    focusWorkspace(workspaceId: string) {
      const id = workspaceId.trim();
      if (!id) return Promise.resolve(false);
      return navigate(
        { kind: "workspace", id },
        () => ({
          method: "workspace.focus",
          params: { workspace_id: id },
          id: "lazycat-webshell:workspace-focus",
        }),
        (state) => applyHerdrWorkspaceFocus(state, id),
      );
    },
    focusTab(tabId: string) {
      const id = tabId.trim();
      if (!id) return Promise.resolve(false);
      return navigate(
        { kind: "tab", id },
        () => ({
          method: "tab.focus",
          params: { tab_id: id },
          id: "lazycat-webshell:tab-focus",
        }),
        (state) => applyHerdrTabFocus(state, id),
      );
    },
    focusPane(paneId: string) {
      const id = paneId.trim();
      if (!id) return Promise.resolve(false);
      return navigate(
        { kind: "pane", id },
        (state) => paneFocusRequest(state, id),
        (state) => applyHerdrPaneFocus(state, id),
      );
    },
  };
}
