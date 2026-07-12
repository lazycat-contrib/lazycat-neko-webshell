import type { MessageKey } from "./i18n";
import type { ClipboardImagePayload, Settings, TerminalPane, Tone } from "./types";
import type { UploadProgressController } from "./upload-progress";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
type ClipboardShortcut = "copy" | "paste";
type ShortcutEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "key" | "metaKey" | "repeat" | "shiftKey"
>;
type ImagePayloadErrorCode = "unsupported-heic" | "too-large" | "compressed-too-large" | "decode-failed";

export type TerminalClipboardController = {
  paneForShortcutTarget: (target: EventTarget | null) => TerminalPane | undefined;
  handleTerminalClipboardCapture: (event: KeyboardEvent) => void;
  handleTerminalPasteEvent: (event: ClipboardEvent) => void;
  scheduleCopySelection: () => void;
  copySelection: (report: boolean, pane?: TerminalPane) => Promise<boolean>;
  pasteIntoPane: (pane: TerminalPane | undefined, report: boolean) => Promise<boolean>;
  pasteImageFileIntoPane: (pane: TerminalPane, file: File, report: boolean) => Promise<boolean>;
  pasteTextIntoPane: (pane: TerminalPane | undefined, text: string) => boolean;
};

export function terminalClipboardShortcut(
  event: ShortcutEvent,
  applePlatform = isApplePlatform(),
): ClipboardShortcut | undefined {
  if (event.altKey || event.repeat) return undefined;
  const key = event.key.toLowerCase();
  const code = event.code;
  const superShortcut = event.metaKey && !applePlatform && !event.ctrlKey && !event.shiftKey;
  const ctrlShiftShortcut = event.ctrlKey && event.shiftKey && !event.metaKey;
  if (!superShortcut && !ctrlShiftShortcut) return undefined;
  if (key === "c" || code === "KeyC") return "copy";
  if (key === "v" || code === "KeyV") return "paste";
  return undefined;
}

export function canUseActivePaneForShortcut(state: {
  targetIsEditable: boolean;
  settingsOpen: boolean;
  hasActiveTab: boolean;
}): boolean {
  return !state.targetIsEditable && !state.settingsOpen && state.hasActiveTab;
}

export function createTerminalClipboardController(options: {
  settings: () => Pick<Settings, "useResttyClipboard">;
  activePane: () => TerminalPane | undefined;
  paneForEventTarget: (target: EventTarget | null) => TerminalPane | undefined;
  settingsOpen: () => boolean;
  hasActiveTab: () => boolean;
  canWrite: (pane: TerminalPane | undefined, options?: { report?: boolean }) => boolean;
  pasteIntoHerdrPane: (pane: TerminalPane, report: boolean) => Promise<boolean>;
  pasteTextIntoHerdrPane: (pane: TerminalPane, text: string, report: boolean) => Promise<boolean>;
  pasteClipboardImageIntoHerdrPane: (
    pane: TerminalPane,
    payload: ClipboardImagePayload,
    report: boolean,
  ) => Promise<boolean>;
  connectPanePty: (pane: TerminalPane) => void;
  focusPaneCanvas: (pane: TerminalPane | undefined) => void;
  scheduleReconnect: (pane: TerminalPane) => void;
  setGlobalStatus: (message: string, tone?: Tone) => void;
  tr: Translate;
  errorMessage: (error: unknown) => string;
  fallbackCopyText: (text: string) => void;
  imageUploadProgress: UploadProgressController;
  clipboardImageFile: (data: DataTransfer | null | undefined) => File | undefined;
  readClipboardImagePayload: () => Promise<ClipboardImagePayload | undefined>;
  imageFilePayload: (file: File) => Promise<ClipboardImagePayload>;
  clipboardImagePayloadIsValid: (payload: ClipboardImagePayload) => boolean;
  imageFilePayloadErrorCode: (error: unknown) => ImagePayloadErrorCode | undefined;
  maxClipboardImageBytes: number;
}): TerminalClipboardController {
  function paneForShortcutTarget(target: EventTarget | null): TerminalPane | undefined {
    const targetedPane = options.paneForEventTarget(target);
    if (targetedPane) return targetedPane;
    const targetIsEditable = target instanceof Element
      && Boolean(target.closest("input, textarea, select, button, [contenteditable='true']"));
    if (!canUseActivePaneForShortcut({
      targetIsEditable,
      settingsOpen: options.settingsOpen(),
      hasActiveTab: options.hasActiveTab(),
    })) {
      return undefined;
    }
    return options.activePane();
  }

  function handleTerminalClipboardCapture(event: KeyboardEvent) {
    const shortcut = terminalClipboardShortcut(event);
    if (!shortcut) return;
    const pane = paneForShortcutTarget(event.target);
    if (!pane) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (shortcut === "copy") {
      void copySelection(false, pane);
    } else {
      void pasteIntoPane(pane, false);
    }
  }

  function handleTerminalPasteEvent(event: ClipboardEvent) {
    const pane = paneForShortcutTarget(event.target);
    if (!pane) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const imageFile = options.clipboardImageFile(event.clipboardData);
    if (imageFile) {
      void pasteImageFileIntoPane(pane, imageFile, false);
      return;
    }
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text) {
      if (pane.sessionBackend === "herdr") {
        void options.pasteTextIntoHerdrPane(pane, text, false);
      } else {
        pasteTextIntoPane(pane, text);
      }
    } else {
      void pasteIntoPane(pane, false);
    }
  }

  function scheduleCopySelection() {
    requestAnimationFrame(() => void copySelection(false));
  }

  async function copySelection(report: boolean, pane = options.activePane()): Promise<boolean> {
    const restty = pane?.term?.restty;
    if (options.settings().useResttyClipboard && restty) {
      try {
        if (await restty.copySelectionToClipboard()) {
          if (report) options.setGlobalStatus(options.tr("status.selectionCopied"), "ok");
          return true;
        }
      } catch (error) {
        if (report) {
          options.setGlobalStatus(
            options.tr("status.copyFailed", { message: options.errorMessage(error) }),
            "error",
          );
        }
        return false;
      }
    }

    const text = window.getSelection()?.toString() ?? "";
    if (!text) {
      if (report) options.setGlobalStatus(options.tr("status.noSelection"));
      return false;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        options.fallbackCopyText(text);
      }
      if (report) options.setGlobalStatus(options.tr("status.selectionCopied"), "ok");
      return true;
    } catch (error) {
      if (report) {
        options.setGlobalStatus(
          options.tr("status.copyFailed", { message: options.errorMessage(error) }),
          "error",
        );
      }
      return false;
    }
  }

  async function pasteIntoPane(
    pane: TerminalPane | undefined,
    report: boolean,
  ): Promise<boolean> {
    if (!pane?.term?.restty) return false;
    if (pane.sessionBackend === "herdr") {
      return options.pasteIntoHerdrPane(pane, report);
    }
    const imagePayload = await options.readClipboardImagePayload();
    if (imagePayload) {
      return sendClipboardImageIntoPane(pane, imagePayload, report);
    }

    if (options.settings().useResttyClipboard) {
      try {
        if (await pane.term.restty.pasteFromClipboard()) {
          options.focusPaneCanvas(pane);
          return true;
        }
      } catch (error) {
        if (report) {
          options.setGlobalStatus(
            options.tr("status.pasteFailed", { message: options.errorMessage(error) }),
            "error",
          );
        }
        return false;
      }
    }

    try {
      const text = await navigator.clipboard?.readText?.() ?? "";
      if (!text) return false;
      return pasteTextIntoPane(pane, text);
    } catch (error) {
      if (report) {
        options.setGlobalStatus(
          options.tr("status.pasteFailed", { message: options.errorMessage(error) }),
          "error",
        );
      }
      return false;
    }
  }

  async function pasteImageFileIntoPane(
    pane: TerminalPane,
    file: File,
    report: boolean,
  ): Promise<boolean> {
    try {
      const payload = await options.imageFilePayload(file);
      if (pane.sessionBackend === "herdr") {
        return options.pasteClipboardImageIntoHerdrPane(pane, payload, report);
      }
      return sendClipboardImageIntoPane(pane, payload, report);
    } catch (error) {
      if (report) {
        options.setGlobalStatus(
          options.tr("status.imageUploadFailed", { message: imageUploadErrorMessage(error) }),
          "error",
        );
      }
      return false;
    }
  }

  function imageUploadErrorMessage(error: unknown): string {
    const code = options.imageFilePayloadErrorCode(error);
    if (code === "unsupported-heic") return options.tr("status.imageUploadHeicUnsupported");
    if (code === "decode-failed") return options.tr("status.imageUploadDecodeFailed");
    if (code) {
      return options.tr("status.imageUploadTooLarge", {
        size: Math.floor(options.maxClipboardImageBytes / (1024 * 1024)),
      });
    }
    return options.errorMessage(error);
  }

  function sendClipboardImageIntoPane(
    pane: TerminalPane | undefined,
    payload: ClipboardImagePayload,
    report: boolean,
  ): boolean {
    if (!pane || pane.closing || pane.exited || !pane.sessionId) return false;
    if (!options.canWrite(pane, { report })) return false;
    if (!options.clipboardImagePayloadIsValid(payload)) return false;
    if (pane.socket?.readyState !== WebSocket.OPEN || pane.replaying) {
      options.connectPanePty(pane);
      if (report) {
        options.setGlobalStatus(
          options.tr("status.pasteFailed", { message: "terminal is reconnecting" }),
          "error",
        );
      }
      return false;
    }
    options.imageUploadProgress.start();
    if (report) options.setGlobalStatus(options.tr("status.imageUploadStarted"));
    try {
      pane.socket.send(JSON.stringify({
        type: "clipboard-image",
        extension: payload.extension,
        size: payload.data.byteLength,
      }));
      options.imageUploadProgress.set(0.35);
      pane.socket.send(payload.data);
      options.imageUploadProgress.set(0.9);
      options.imageUploadProgress.finish();
      if (report) options.setGlobalStatus(options.tr("status.imageUploadDone"), "ok");
      options.focusPaneCanvas(pane);
      return true;
    } catch (error) {
      options.imageUploadProgress.fail();
      if (report) {
        options.setGlobalStatus(
          options.tr("status.imageUploadFailed", { message: options.errorMessage(error) }),
          "error",
        );
      }
      options.scheduleReconnect(pane);
      return false;
    }
  }

  function pasteTextIntoPane(pane: TerminalPane | undefined, text: string): boolean {
    if (!pane?.term?.restty || !text) return false;
    if (!options.canWrite(pane)) return false;
    pane.term.restty.sendKeyInput(text);
    options.focusPaneCanvas(pane);
    return true;
  }

  return {
    paneForShortcutTarget,
    handleTerminalClipboardCapture,
    handleTerminalPasteEvent,
    scheduleCopySelection,
    copySelection,
    pasteIntoPane,
    pasteImageFileIntoPane,
    pasteTextIntoPane,
  };
}

function isApplePlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}
