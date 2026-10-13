import type { MessageKey } from "../../i18n";
import { shellQuotePath } from "../../shell-quote-path.ts";
import type { TerminalPane, Tone } from "../../types";
import { errorMessage } from "../../utils.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export function paneAcceptsFileDrop(pane: TerminalPane): boolean {
  return Boolean(pane.sessionId && !pane.closing && !pane.exited && pane.sessionBackend !== "herdr");
}

export function hasDroppedFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && (
    Array.from(transfer.types ?? []).includes("Files")
    || Array.from(transfer.items ?? []).some((item) => item.kind === "file")
  ));
}

export function createPaneFileDropController(options: {
  root: Document;
  window: Window;
  paneForTarget: (target: EventTarget | null) => TerminalPane | undefined;
  canUpload: (pane: TerminalPane) => boolean;
  isCurrent: (pane: TerminalPane, sessionId: string, selector: string) => boolean;
  upload: (
    files: File[], pane: TerminalPane,
    onProgress: (meta: Record<string, unknown>, fileIndex: number) => void,
  ) => Promise<string[]>;
  sendText: (pane: TerminalPane, text: string) => Promise<boolean>;
  focus: (pane: TerminalPane) => void;
  tr: Translate;
  onStatus: (message: string, tone?: Tone) => void;
}) {
  let hovered: TerminalPane | undefined;
  let busy = false;

  const clear = () => {
    hovered?.mount.querySelector(".pane-file-drop-overlay")?.remove();
    hovered = undefined;
  };

  const show = (pane: TerminalPane | undefined) => {
    if (hovered === pane) return;
    clear();
    if (!pane) return;
    hovered = pane;
    const overlay = pane.mount.ownerDocument.createElement("div");
    overlay.className = "pane-file-drop-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.textContent = options.tr("status.dropFilesToPane");
    pane.mount.appendChild(overlay);
  };

  const isFileInput = (target: EventTarget | null) => (
    typeof Element !== "undefined" && target instanceof Element
    && Boolean(target.closest('input[type="file"]'))
  );

  const onDragOver = (event: DragEvent) => {
    if (!hasDroppedFiles(event.dataTransfer)) return;
    if (isFileInput(event.target)) {
      clear();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pane = options.paneForTarget(event.target);
    const available = !busy && pane && options.canUpload(pane) ? pane : undefined;
    show(available);
    if (event.dataTransfer) event.dataTransfer.dropEffect = available ? "copy" : "none";
  };

  const onDrop = (event: DragEvent) => {
    if (!hasDroppedFiles(event.dataTransfer) || isFileInput(event.target)) {
      clear();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const pane = options.paneForTarget(event.target);
    const files = Array.from(event.dataTransfer?.files ?? []);
    clear();
    if (busy || !pane || !files.length) return;
    if (!options.canUpload(pane)) {
      options.onStatus(options.tr("status.terminalInputFileUploadUnavailable"), "error");
      return;
    }
    const sessionId = pane.sessionId;
    if (!sessionId) return;
    const selector = pane.selector;
    busy = true;
    void (async () => {
      try {
        const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
        let lastPercent = -1;
        const reportProgress = (meta: Record<string, unknown>, fileIndex: number) => {
          const filePercent = Number(meta.percent);
          if (!Number.isFinite(filePercent) || fileIndex < 0 || fileIndex >= files.length) return;
          const completedBytes = files.slice(0, fileIndex).reduce((sum, file) => sum + file.size, 0);
          const currentBytes = files[fileIndex].size * Math.max(0, Math.min(100, filePercent)) / 100;
          const percent = totalBytes > 0
            ? Math.floor((completedBytes + currentBytes) / totalBytes * 100)
            : Math.floor((fileIndex + filePercent / 100) / files.length * 100);
          if (percent < lastPercent + 2 && percent !== 100) return;
          lastPercent = percent;
          options.onStatus(options.tr("status.dropFilesUploading", { percent }), "neutral");
        };
        options.onStatus(options.tr("status.dropFilesUploading", { percent: 0 }), "neutral");
        const paths = await options.upload(files, pane, reportProgress);
        if (!paths.length) {
          options.onStatus(options.tr("status.terminalInputFileUploadFailed"), "error");
          return;
        }
        if (!options.isCurrent(pane, sessionId, selector)) {
          options.onStatus(options.tr("status.dropFilesPathInsertFailed"), "error");
          return;
        }
        const sent = await options.sendText(pane, paths.map(shellQuotePath).join(" "));
        if (sent) {
          options.focus(pane);
          options.onStatus(options.tr("status.terminalInputTemporaryPathsInserted"), "ok");
        } else {
          options.onStatus(options.tr("status.dropFilesPathInsertFailed"), "error");
        }
      } catch (error) {
        options.onStatus(errorMessage(error), "error");
      } finally {
        busy = false;
      }
    })();
  };

  const onDragLeave = (event: DragEvent) => {
    if (!options.root.elementFromPoint(event.clientX, event.clientY)) clear();
  };

  options.root.addEventListener("dragover", onDragOver, true);
  options.root.addEventListener("drop", onDrop, true);
  options.root.addEventListener("dragleave", onDragLeave, true);
  options.root.addEventListener("dragend", clear, true);
  options.window.addEventListener("blur", clear);

  return () => {
    clear();
    options.root.removeEventListener("dragover", onDragOver, true);
    options.root.removeEventListener("drop", onDrop, true);
    options.root.removeEventListener("dragleave", onDragLeave, true);
    options.root.removeEventListener("dragend", clear, true);
    options.window.removeEventListener("blur", clear);
  };
}
