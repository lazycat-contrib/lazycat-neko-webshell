import type { HerdrBridgeState, TerminalPane } from "../types.ts";

export type MobileInputTarget = {
  key: string;
  label: string;
  pane: TerminalPane;
  selector: string;
  sessionId: string;
  generation: number;
  herdrPaneId?: string;
};

export function captureMobileInputTarget(pane: TerminalPane | undefined, generation: number, herdr?: HerdrBridgeState): MobileInputTarget | undefined {
  if (!pane?.sessionId || pane.closing || pane.exited) return undefined;
  const herdrPaneId = pane.sessionBackend === "herdr"
    ? herdr?.selector === pane.selector && herdr.available
      ? herdr.focused_pane_id || herdr.panes.find(item => item.focused)?.pane_id
      : undefined
    : undefined;
  if (pane.sessionBackend === "herdr" && !herdrPaneId) return undefined;
  const remote = herdr?.panes.find(item => item.pane_id === herdrPaneId);
  return {
    key: JSON.stringify(herdrPaneId ? [pane.selector, "herdr", herdrPaneId] : [pane.selector, pane.sessionId, pane.id]),
    label: `${pane.selector} · ${remote?.terminal_title_stripped || remote?.title || pane.title || pane.label}`,
    pane, selector: pane.selector, sessionId: pane.sessionId, generation, herdrPaneId,
  };
}

export function sameMobileInputTarget(expected: MobileInputTarget, current: MobileInputTarget | undefined): boolean {
  return Boolean(current && expected.key === current.key && expected.pane === current.pane && expected.generation === current.generation && expected.sessionId === current.sessionId);
}

/** Closing/exited are provisional: only authoritative removal retires a draft. */
export function mobileInputTargetRetired(target: MobileInputTarget, livePanes?: readonly TerminalPane[], herdr?: HerdrBridgeState): boolean {
  if (target.herdrPaneId) {
    return Boolean(herdr?.available && herdr.resources_complete && herdr.selector === target.selector
      && !herdr.panes.some(item => item.pane_id === target.herdrPaneId));
  }
  if (!livePanes) return false;
  const pane = livePanes.find(item => item.id === target.pane.id && item.selector === target.selector);
  return !pane || Boolean(pane.sessionId && pane.sessionId !== target.sessionId);
}
