export function isEditableElementTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}

export function activeEditableElementIn(container: ParentNode | null | undefined): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container?.contains(active)) return false;
  return isEditableElementTarget(active);
}
