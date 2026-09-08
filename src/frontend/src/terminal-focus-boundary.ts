export type TerminalFocusBoundaryOptions = {
  root: EventTarget;
  canvas: () => EventTarget | null;
  input: EventTarget;
  defer?: (callback: () => void) => void;
};

/** Moving between the renderer canvas and its IME input keeps terminal focus. */
export function createTerminalFocusBoundary(options: TerminalFocusBoundaryOptions) {
  const defer = options.defer ?? queueMicrotask;
  let internalBlur = false;
  let generation = 0;
  let disposed = false;

  function onBlur(event: Event) {
    const canvas = options.canvas();
    const related = (event as FocusEvent).relatedTarget;
    internalBlur = Boolean(canvas && (
      (event.target === canvas && related === options.input)
      || (event.target === options.input && related === canvas)
    ));
    const current = ++generation;
    // Restty emits its focus report synchronously in the target blur handler.
    // Do not suppress later programmatic reports after this DOM transition.
    defer(() => { if (generation === current) internalBlur = false; });
  }

  options.root.addEventListener("blur", onBlur, true);
  return {
    suppress(text: string, source: string): boolean {
      return !disposed && internalBlur && source === "program" && text === "\x1b[O";
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      internalBlur = false;
      generation++;
      options.root.removeEventListener("blur", onBlur, true);
    },
  };
}
