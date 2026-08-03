export function normalizePreventMobileKeyboardAutoOpen(
  value: unknown,
  fallback = false,
): boolean {
  return typeof value === "boolean" ? value : fallback;
}
