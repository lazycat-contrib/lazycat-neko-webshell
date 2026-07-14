import { normalizeSelector } from "./workspace-selection.ts";

const OPEN_SELECTORS_KEY = "lazycat-neko-webshell.openSelectors";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

export function readOpenSelectors(storage: StorageLike = window.localStorage): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(OPEN_SELECTORS_KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    const selectors = parsed
      .filter((value): value is string => typeof value === "string")
      .map(normalizeSelector)
      .filter(Boolean);
    return [...new Set(selectors)];
  } catch {
    return [];
  }
}

export function rememberOpenSelector(
  selector: string,
  storage: StorageLike = window.localStorage,
) {
  const normalized = normalizeSelector(selector);
  if (!normalized) return;
  const current = readOpenSelectors(storage);
  if (current.includes(normalized)) return;
  persistOpenSelectors([...current, normalized], storage);
}

export function forgetOpenSelector(
  selector: string,
  storage: StorageLike = window.localStorage,
) {
  const normalized = normalizeSelector(selector);
  persistOpenSelectors(
    readOpenSelectors(storage).filter((item) => item !== normalized),
    storage,
  );
}

function persistOpenSelectors(selectors: string[], storage: StorageLike) {
  try {
    storage.setItem(OPEN_SELECTORS_KEY, JSON.stringify(selectors));
  } catch {
    // Persistence is best-effort; the active URL and server workspace remain authoritative.
  }
}
