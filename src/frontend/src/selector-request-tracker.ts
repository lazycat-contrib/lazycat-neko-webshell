import { normalizeSelector } from "./workspace-selection.ts";

export function createSelectorRequestTracker() {
  const generations = new Map<string, number>();
  return {
    begin(selector: string): number {
      const key = normalizeSelector(selector);
      const next = (generations.get(key) ?? 0) + 1;
      generations.set(key, next);
      return next;
    },
    isCurrent(selector: string, generation: number): boolean {
      return generations.get(normalizeSelector(selector)) === generation;
    },
  };
}
