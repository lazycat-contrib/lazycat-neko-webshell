type ClipboardWriteOptions = {
  writeText?: (text: string) => Promise<void>;
  fallbackCopy?: (text: string) => boolean;
};

export async function writeSystemClipboardText(
  text: string,
  options: ClipboardWriteOptions = {},
): Promise<void> {
  if (!text) throw new Error("clipboard text is empty");
  const writeText = options.writeText ?? navigator.clipboard?.writeText?.bind(navigator.clipboard);
  const fallbackCopy = options.fallbackCopy ?? legacyCopyText;
  let writeError: unknown;

  if (writeText) {
    try {
      await writeText(text);
      return;
    } catch (error) {
      writeError = error;
    }
  }

  try {
    if (fallbackCopy(text)) return;
  } catch (error) {
    writeError ??= error;
  }

  if (writeError instanceof Error) throw writeError;
  throw new Error("system clipboard access is unavailable");
}

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
