import type { WorkspaceAction } from "./types";
import { normalizeSelector } from "./workspace-selection.ts";

export type WorkspaceRequest = { isCurrent: () => boolean; focusUnchanged: () => boolean };

/** Structural work owns a selector lane through application, not just through fetch. */
export function createWorkspaceRequestController() {
  const states = new Map<string, { revision: number; read: number; readPending: boolean; focus: number; pending: number; tail: Promise<unknown>; focusTail: Promise<unknown> }>();
  let disposed = false;
  const stateFor = (selector: string) => {
    const key = normalizeSelector(selector);
    let state = states.get(key);
    if (!state) {
      state = { revision: 0, read: 0, readPending: false, focus: 0, pending: 0, tail: Promise.resolve(), focusTail: Promise.resolve() };
      states.set(key, state);
    }
    return { key, state };
  };
  return {
    read(selector: string, options: { passive?: boolean } = {}): WorkspaceRequest & { finish: () => void } {
      const { key, state } = stateFor(selector);
      if (disposed || state.pending > 0 || (options.passive && state.readPending)) {
        return { isCurrent: () => false, focusUnchanged: () => true, finish() {} };
      }
      state.readPending = true;
      const revision = state.revision;
      const read = ++state.read;
      const focus = state.focus;
      const idle = state.pending === 0;
      return {
        isCurrent: () => !disposed && states.get(key) === state && idle && state.pending === 0 && state.revision === revision && state.read === read,
        focusUnchanged: () => state.focus === focus,
        finish: () => { if (state.read === read) state.readPending = false; },
      };
    },
    run<T>(selector: string, kind: "mutation" | "focus", work: (request: WorkspaceRequest) => Promise<T>): Promise<T | undefined> {
      const { key, state } = stateFor(selector);
      if (disposed) return Promise.resolve(undefined);
      if (kind === "mutation") { state.revision++; state.pending++; }
      else state.focus++;
      const focus = state.focus;
      const request = {
        isCurrent: () => !disposed && states.get(key) === state,
        focusUnchanged: () => state.focus === focus,
      };
      const lane = kind === "mutation" ? "tail" : "focusTail";
      const result = state[lane].catch(() => undefined).then(async () => {
        try { return request.isCurrent() ? await work(request) : undefined; }
        finally { if (kind === "mutation") state.pending--; }
      });
      state[lane] = result;
      return result;
    },
    invalidate(selector: string) { states.delete(normalizeSelector(selector)); },
    dispose() { disposed = true; states.clear(); },
  };
}

export function workspaceActionChangesFocus(action: WorkspaceAction): boolean {
  return action === "create_tab" || action === "split_pane" || action === "promote_pane_to_tab"
    || action === "close_tab" || action === "close_pane";
}
