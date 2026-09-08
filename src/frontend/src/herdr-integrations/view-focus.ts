export function herdrIntegrationsTabTarget<T>(
  focusable: T[],
  active: T | undefined,
  shiftKey: boolean,
): T | undefined {
  const first = focusable[0];
  const last = focusable.at(-1);
  if (!first || !last) return undefined;
  if (shiftKey && (active === first || !focusable.includes(active as T))) return last;
  if (!shiftKey && (active === last || !focusable.includes(active as T))) return first;
  return undefined;
}

export function restoreHerdrIntegrationsFocus(
  target: Pick<HTMLElement, "focus" | "isConnected"> | undefined,
) {
  if (target && target.isConnected) target.focus({ preventScroll: true });
}
