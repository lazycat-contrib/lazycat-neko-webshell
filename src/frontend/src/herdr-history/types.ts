export type HistoryTarget = { selector: string; generation: number; paneId: string; sessionId: string };
export type HistoryPane = { id: string; label: string };
export type TextPoint = { row: number; col: number };
export type TextRange = { start: TextPoint; end: TextPoint };
export type HistoryStatus = "choose" | "loading" | "ready" | "searching" | "copying" | "copied"
  | "copyError" | "empty" | "unsupported" | "stale" | "error" | "targetChanged" | "queryTooLong";
export type HistoryState = {
  panes: HistoryPane[];
  paneId: string;
  query: string;
  status: HistoryStatus;
  match?: TextRange;
  position?: number;
  total: number;
  preview: string;
};

export function historyTargetFromPane(options: {
  selector: string; generation: number;
  pane?: { id: string; selector: string; sessionId?: string; closing: boolean };
}): HistoryTarget | undefined {
  const { pane } = options;
  const selector = options.selector.trim();
  if (!selector || !pane || pane.closing || pane.selector.trim() !== selector || !pane.sessionId) return;
  return { selector, generation: options.generation, paneId: pane.id, sessionId: pane.sessionId };
}

export function sameHistoryTarget(a: HistoryTarget | undefined, b: HistoryTarget | undefined): boolean {
  return Boolean(a && b && a.selector === b.selector && a.generation === b.generation
    && a.paneId === b.paneId && a.sessionId === b.sessionId);
}
