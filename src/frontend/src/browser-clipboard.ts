type ClipboardWriteOptions = {
  writeText?: (text: string) => Promise<void>;
  fallbackCopy?: (text: string) => boolean;
  isCurrent?: () => boolean;
  nativeStallTimeoutMs?: number;
};

const DEFAULT_NATIVE_CLIPBOARD_STALL_TIMEOUT_MS = 2_000;

export function createSystemClipboardWriter(defaultOptions: ClipboardWriteOptions = {}) {
  let nativeClipboardStalled = false;
  let nativeClipboardWriteInFlight = false;

  return async function writeSystemClipboardText(
    text: string,
    options: ClipboardWriteOptions = {},
  ): Promise<void> {
    if (!text) throw new Error("clipboard text is empty");
    const nativeClipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    const writeText = options.writeText
      ?? defaultOptions.writeText
      ?? nativeClipboard?.writeText?.bind(nativeClipboard);
    const fallbackCopy = options.fallbackCopy ?? defaultOptions.fallbackCopy ?? legacyCopyText;
    const isCurrent = options.isCurrent ?? defaultOptions.isCurrent ?? (() => true);
    const nativeStallTimeoutMs = Math.max(
      1,
      options.nativeStallTimeoutMs
        ?? defaultOptions.nativeStallTimeoutMs
        ?? DEFAULT_NATIVE_CLIPBOARD_STALL_TIMEOUT_MS,
    );
    let writeError: unknown;

    if (!isCurrent()) return;
    if (writeText && !nativeClipboardStalled && !nativeClipboardWriteInFlight) {
      nativeClipboardWriteInFlight = true;
      let didStall = false;
      const stallTimer = setTimeout(() => {
        didStall = true;
        nativeClipboardStalled = true;
      }, nativeStallTimeoutMs);
      try {
        await writeText(text);
        return;
      } catch (error) {
        writeError = error;
      } finally {
        clearTimeout(stallTimer);
        nativeClipboardWriteInFlight = false;
        if (didStall) nativeClipboardStalled = false;
      }
    }

    if (!isCurrent()) return;
    try {
      if (fallbackCopy(text)) return;
    } catch (error) {
      writeError ??= error;
    }

    if (writeError instanceof Error) throw writeError;
    throw new Error("system clipboard access is unavailable");
  };
}

export const writeSystemClipboardText = createSystemClipboardWriter();

export function legacyCopyText(text: string, ownerDocument = document): boolean {
  if (!text || typeof ownerDocument.execCommand !== "function") return false;
  const restoreFocus = ownerDocument.activeElement;
  const textarea = ownerDocument.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto -9999px";
  textarea.style.opacity = "0";
  ownerDocument.body.appendChild(textarea);
  textarea.select();
  let copied = false;
  try {
    copied = ownerDocument.execCommand("copy");
  } finally {
    textarea.remove();
    if (restoreFocus instanceof HTMLElement) {
      restoreFocus.focus({ preventScroll: true });
    }
  }
  return copied;
}
