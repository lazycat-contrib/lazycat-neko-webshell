import type { ActionResponseMeta, TerminalActionWSClient } from "../../action-ws-client";
import type { MessageKey } from "../../i18n";
import { base64ToBytes, metaString } from "../../json-meta";
import { downloadPluginPayload, transferProgressText } from "../../plugin-utils";
import {
  fileNameFromPath,
  normalizeRemotePath,
  parentRemotePath,
  parseFileBrowserEntries,
  uploadTargetPath,
} from "../../remote-files";
import type { Tone } from "../../types";
import { errorMessage } from "../../utils";
import { FileBrowserStore } from "./store";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type FileTransferPane = {
  id: string;
  sessionId?: string;
  workingDirectory?: string;
};

type FileTransferControllerDeps = {
  isEnabled: () => boolean;
  activePane: () => FileTransferPane | undefined;
  actionClient: Pick<TerminalActionWSClient, "send" | "uploadFile">;
  tr: Translate;
  onOutput: (message: string, tone?: Tone) => void;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
};

export function createFileTransferController(deps: FileTransferControllerDeps) {
  const store = new FileBrowserStore();

  function activeSessionId(): string | undefined {
    return deps.activePane()?.sessionId;
  }

  function output(message: string, tone: Tone = "neutral") {
    deps.onOutput(message, tone);
  }

  async function loadDirectory(path: string) {
    if (!deps.isEnabled()) return;
    const sessionId = activeSessionId();
    if (!sessionId) {
      output(deps.tr("status.pluginFileNoSession"), "error");
      return;
    }
    const directory = store.beginDirectoryLoad(path);
    deps.onRender();
    try {
      let stream = "";
      await deps.actionClient.send("transfer", "list", {
        sessionId,
        path: directory,
      }, {
        onStream: (chunk) => {
          stream += chunk;
        },
      });
      store.finishDirectoryLoad(directory, parseFileBrowserEntries(directory, stream));
      output("");
    } catch (error) {
      store.failDirectoryLoad();
      output(errorMessage(error), "error");
    } finally {
      store.finishDirectoryLoadWithoutChanges();
      deps.onRender();
    }
  }

  return {
    viewState: () => ({
      fileBrowserPath: store.path,
      selectedFileBrowserPath: store.selectedPath,
      fileBrowserEntries: store.entries,
      fileBrowserLoading: store.loading,
      fileBrowserContextMenu: store.contextMenu,
    }),
    hasContextMenu: () => Boolean(store.contextMenu),
    clearContextMenu() {
      if (!store.contextMenu) return false;
      store.clearContextMenu();
      return true;
    },
    openContextMenu(path: string, x: number, y: number) {
      store.openContextMenu(path, x, y);
      deps.onRender();
    },
    selectMenuPath(path: string) {
      store.selectPath(path || store.selectedPath);
      store.clearContextMenu();
    },
    syncPathWithPane(force = false) {
      const pane = deps.activePane();
      store.syncPathWithPane(pane?.id ?? "", pane?.workingDirectory || "", force);
    },
    syncObservedPane(paneId: string) {
      const pane = deps.activePane();
      if (pane?.id === paneId && !store.loadedPath) {
        store.syncPathWithPane(pane.id, pane.workingDirectory || "");
      }
    },
    async loadCurrentDirectoryIfStale() {
      if (!store.loading && store.loadedPath !== normalizeRemotePath(store.path)) {
        await loadDirectory(store.path);
      }
    },
    async activateEntry(path: string, open = false) {
      const entry = store.entries.find((item) => item.path === path);
      if (!entry) return;
      store.selectPath(entry.path);
      store.clearContextMenu();
      if (open && (entry.kind === "directory" || entry.kind === "symlink")) {
        await loadDirectory(entry.path);
        return;
      }
      deps.onRender();
    },
    async runAction(action: string) {
      if (!deps.isEnabled()) return;
      if (action === "home") {
        await loadDirectory("/");
        return;
      }
      if (action === "sync-cwd") {
        this.syncPathWithPane(true);
        await loadDirectory(store.path);
        return;
      }
      if (action === "parent") {
        await loadDirectory(parentRemotePath(store.path));
        return;
      }
      if (action === "refresh" || action === "list") {
        await loadDirectory(store.path);
        return;
      }
      if (action === "open") {
        const entry = store.selectedEntry();
        if (entry?.kind === "directory" || entry?.kind === "symlink") {
          await loadDirectory(entry.path);
        }
        return;
      }
      if (action !== "read" && action !== "stat" && action !== "download") return;
      const path = store.selectedPath || store.path;
      if (!path) {
        output(deps.tr("validation.pluginPath"), "error");
        return;
      }
      const sessionId = activeSessionId();
      if (!sessionId) {
        output(deps.tr("status.pluginFileNoSession"), "error");
        return;
      }
      output("");
      try {
        let stream = "";
        const done = await deps.actionClient.send("transfer", action, {
          sessionId,
          path,
        }, {
          onStream: (chunk) => {
            stream += chunk;
            output(stream, "ok");
          },
          onProgress: (meta: ActionResponseMeta) => output(transferProgressText(meta), "neutral"),
        });
        if (action === "download") {
          const data = metaString(done.meta, "data");
          if (data) {
            downloadPluginPayload(
              base64ToBytes(data),
              metaString(done.meta, "name") || fileNameFromPath(path),
              metaString(done.meta, "contentType") || "application/octet-stream",
            );
          }
        } else if (!stream) {
          const content = metaString(done.meta, "content");
          if (content) output(content, "ok");
        }
        deps.onStatus(deps.tr("status.pluginFileDone", { operation: action }), "ok");
      } catch (error) {
        output(errorMessage(error), "error");
        deps.onStatus(errorMessage(error), "error");
      }
    },
    async upload(files: File[]) {
      if (!deps.isEnabled() || !files.length) return;
      const sessionId = activeSessionId();
      if (!sessionId) {
        output(deps.tr("status.pluginFileNoSession"), "error");
        return;
      }
      const directory = store.uploadDirectory();
      if (!directory) {
        output(deps.tr("validation.pluginPath"), "error");
        return;
      }
      output("");
      try {
        for (const file of files) {
          const targetPath = uploadTargetPath(directory, file.name);
          const done = await deps.actionClient.uploadFile(file, sessionId, targetPath, {
            onProgress: (meta: ActionResponseMeta) => output(transferProgressText(meta), "neutral"),
          });
          const message = metaString(done.meta, "content") || transferProgressText(done.meta);
          output(message, "ok");
        }
        await loadDirectory(directory);
        deps.onStatus(deps.tr("status.pluginFileUploadDone", {
          name: files.length === 1 ? files[0]?.name ?? "" : String(files.length),
        }), "ok");
      } catch (error) {
        output(errorMessage(error), "error");
        deps.onStatus(errorMessage(error), "error");
      }
    },
  };
}
