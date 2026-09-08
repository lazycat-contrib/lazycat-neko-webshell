type ClipboardDeps = {
  writeItem?: (text: Promise<Blob>) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
  fallbackCopy: (text: string) => boolean;
};

/** Start promise-backed clipboard access in the click task, before the revision read finishes. */
export async function writeHistoryClipboard(text: Promise<string>, isCurrent: () => boolean, deps: ClipboardDeps): Promise<void> {
  const checked = text.then((value) => {
    if (!isCurrent()) throw new Error("History target changed");
    return value;
  });
  // Some browsers reject the clipboard operation without consuming its item.
  void checked.catch(() => {});
  let failure: unknown;
  if (deps.writeItem && isCurrent()) {
    const data = checked.then((value) => new Blob([value], { type: "text/plain" }));
    void data.catch(() => {});
    try { await deps.writeItem(data); await checked; return; } catch (error) { failure = error; }
  }
  const value = await checked;
  if (!isCurrent()) throw new Error("History target changed");
  if (!deps.writeItem && deps.writeText) {
    try { await deps.writeText(value); return; } catch (error) { failure = error; }
  }
  if (isCurrent() && deps.fallbackCopy(value)) return;
  throw failure instanceof Error ? failure : new Error("Clipboard access unavailable");
}

export function copyHerdrHistoryText(text: Promise<string>, isCurrent: () => boolean, host: HTMLElement | undefined) {
  const clipboard = navigator.clipboard;
  return writeHistoryClipboard(text, isCurrent, {
    writeItem: typeof clipboard?.write === "function" && typeof ClipboardItem === "function"
      ? (data) => clipboard.write([new ClipboardItem({ "text/plain": data })]) : undefined,
    writeText: clipboard?.writeText?.bind(clipboard),
    fallbackCopy: (value) => copyInsideHistoryDialog(value, host),
  });
}

function copyInsideHistoryDialog(text: string, host: HTMLElement | undefined): boolean {
  if (!host?.isConnected || typeof host.ownerDocument.execCommand !== "function") return false;
  const document = host.ownerDocument;
  const active = document.activeElement;
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
  // A textarea under body is inert while a native modal dialog is open.
  host.append(input);
  try {
    input.select();
    return document.execCommand("copy");
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected) active.focus({ preventScroll: true });
  }
}
