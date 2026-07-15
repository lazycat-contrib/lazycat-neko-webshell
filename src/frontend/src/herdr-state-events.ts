import { herdrPaneInfoFromEvent, herdrWorkspaceInfoFromEvent } from "./herdr-socket-api.ts";
import type { HerdrBridgeState, JsonRecord } from "./types";

export type HerdrResourceEventResult = {
  state: HerdrBridgeState;
  applied: boolean;
};

export function applyHerdrResourceEvent(
  state: HerdrBridgeState,
  event: string,
  data: JsonRecord,
): HerdrResourceEventResult {
  if (event === "workspace.metadata_updated") {
    const workspace = herdrWorkspaceInfoFromEvent(data);
    if (!workspace || !state.workspaces.some((item) => item.workspace_id === workspace.workspace_id)) {
      return { state, applied: false };
    }
    return {
      state: {
        ...state,
        workspaces: state.workspaces.map((item) => (
          item.workspace_id === workspace.workspace_id ? workspace : item
        )),
      },
      applied: true,
    };
  }

  if (event === "pane.updated") {
    const pane = herdrPaneInfoFromEvent(data);
    if (!pane || !state.panes.some((item) => item.pane_id === pane.pane_id)) {
      return { state, applied: false };
    }
    return {
      state: {
        ...state,
        panes: state.panes.map((item) => item.pane_id === pane.pane_id ? pane : item),
      },
      applied: true,
    };
  }

  return { state, applied: false };
}
