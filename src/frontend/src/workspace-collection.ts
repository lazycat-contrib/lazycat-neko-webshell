import type { TerminalTab } from "./types";
import { normalizeSelector } from "./workspace-selection.ts";

export function replaceSelectorTabs<T extends Pick<TerminalTab, "id" | "selector">>(
  tabs: T[],
  selector: string,
  replacements: T[],
  insertAfterId?: string,
): T[] {
  const normalized = normalizeSelector(selector);
  const first = tabs.findIndex((tab) => normalizeSelector(tab.selector) === normalized);
  const retained = tabs.filter((tab) => normalizeSelector(tab.selector) !== normalized);
  let index = first >= 0 ? Math.min(first, retained.length) : retained.length;
  if (first < 0 && insertAfterId) {
    const anchor = retained.findIndex((tab) => tab.id === insertAfterId);
    if (anchor >= 0) index = anchor + 1;
  }
  return [...retained.slice(0, index), ...replacements, ...retained.slice(index)];
}

export function activeTabAfterSelectorReconcile<
  T extends Pick<TerminalTab, "id" | "selector">,
>(
  previous: string | undefined,
  tabs: T[],
  selector: string,
  preferred: string | undefined,
  activateSelector: boolean,
): string | undefined {
  if (!activateSelector && previous && tabs.some((tab) => tab.id === previous)) return previous;
  if (preferred && tabs.some((tab) => tab.id === preferred)) return preferred;
  return tabs.find((tab) => normalizeSelector(tab.selector) === normalizeSelector(selector))?.id
    ?? tabs.find((tab) => tab.id === previous)?.id
    ?? tabs[0]?.id;
}
