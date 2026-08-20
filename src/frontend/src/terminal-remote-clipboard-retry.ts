import type { TerminalPane } from "./types";

export type TerminalRemoteClipboardRetry = {
  attach: () => void;
  handleWriteStart: (text: string) => void;
  handleWriteError: (error: unknown, text: string) => void;
  handleWriteSuccess: (text: string) => void;
  retry: () => Promise<void>;
  clear: () => void;
  dispose: () => void;
};

export function discardInactiveRemoteClipboardRetries(
  panes: Pick<TerminalPane, "id" | "remoteClipboardRetryClear">[],
  activePaneId: string | undefined,
) {
  for (const pane of panes) {
    if (pane.id !== activePaneId) pane.remoteClipboardRetryClear?.();
  }
}

export function discardAllRemoteClipboardRetries(
  panes: Pick<TerminalPane, "remoteClipboardRetryClear">[],
) {
  for (const pane of panes) pane.remoteClipboardRetryClear?.();
}

export function createTerminalRemoteClipboardRetry(options: {
  mount: HTMLElement;
  enabled: () => boolean;
  writeText: (
    text: string,
    onReconciliationError?: (error: unknown, text: string) => void,
  ) => Promise<void | boolean>;
  message: string;
  actionLabel: string;
  onCopied: () => void;
  onBlocked: (error: unknown) => void;
  ownerDocument?: Document;
}): TerminalRemoteClipboardRetry {
  const ownerDocument = options.ownerDocument ?? document;
  const root = ownerDocument.createElement("div");
  root.className = "remote-clipboard-retry";
  root.hidden = true;
  root.setAttribute("role", "status");
  root.setAttribute("aria-live", "polite");

  const message = ownerDocument.createElement("span");
  message.textContent = options.message;
  const button = ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = options.actionLabel;
  button.setAttribute("aria-busy", "false");
  root.append(message, button);

  let pendingText: string | undefined;
  let disposed = false;
  let retrying = false;
  let generation = 0;

  function attach() {
    if (!disposed && !root.isConnected) options.mount.append(root);
  }

  function handleWriteError(error: unknown, text: string) {
    if (disposed || !text) return;
    if (!options.enabled()) {
      clearPending();
      return;
    }
    pendingText = text;
    button.disabled = false;
    root.hidden = false;
    options.onBlocked(error);
  }

  function handleWriteStart(_text: string) {
    clearPending();
  }

  function handleWriteSuccess(_text: string) {
    clearPending();
  }

  async function retry() {
    const text = pendingText;
    if (disposed || retrying || !text) return;
    if (!options.enabled()) {
      clearPending();
      return;
    }
    const retryGeneration = generation;
    retrying = true;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const written = await options.writeText(text, handleWriteError);
      if (written === false) return;
      if (disposed || generation !== retryGeneration || !options.enabled()) return;
      clearPending();
      options.onCopied();
    } catch (error) {
      if (!disposed && generation === retryGeneration && options.enabled()) {
        options.onBlocked(error);
      }
    } finally {
      retrying = false;
      button.setAttribute("aria-busy", "false");
      if (pendingText !== undefined) button.disabled = false;
    }
  }

  function clearPending() {
    generation += 1;
    pendingText = undefined;
    root.hidden = true;
    button.disabled = false;
    button.setAttribute("aria-busy", "false");
  }

  function dispose() {
    disposed = true;
    clearPending();
    root.remove();
  }

  button.addEventListener("click", () => {
    void retry();
  });

  return {
    attach,
    handleWriteStart,
    handleWriteError,
    handleWriteSuccess,
    retry,
    clear: clearPending,
    dispose,
  };
}
