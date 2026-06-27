import type { Client } from "@connectrpc/connect";

import type { MessageKey } from "../../i18n";
import { metaString } from "../../json-meta";
import { downloadPluginPayload, transferProgressText } from "../../plugin-utils";
import {
  fileNameFromPath,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  parseFileBrowserEntries,
  uploadTargetPath,
} from "../../remote-files";
import type { Tone } from "../../types";
import { errorMessage } from "../../utils";
import {
  invokeFileTransferWithConnect,
  responsePayloadText,
  uploadFileWithConnect,
} from "./connect-upload";
import { FileBrowserStore } from "./store";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
type CapabilityClient = Client<typeof import("../../gen/lazycat/webshell/v1/capability_pb").CapabilityService>;

type FileTransferPane = {
  id: string;
  sessionId?: string;
  workingDirectory?: string;
};

type FileTransferControllerDeps = {
  isEnabled: () => boolean;
  activePane: () => FileTransferPane | undefined;
  capabilityClient: CapabilityClient;
  tr: Translate;
  onOutput: (message: string, tone?: Tone) => void;
  onStatus: (message: string, tone?: Tone) => void;
  onRender: () => void;
};

const TEMP_UPLOAD_ROOT = "/tmp/lazycat-webshell-uploads";

export function createFileTransferController(deps: FileTransferControllerDeps) {
  const store = new FileBrowserStore();

  function activeSessionId(): string | undefined {
    return deps.activePane()?.sessionId;
  }

  function output(message: string, tone: Tone = "neutral") {
    deps.onOutput(message, tone);
  }

  function reportProgress(meta: Record<string, unknown> | undefined) {
    const message = transferProgressText(meta);
    if (!message) return;
    output(message, "neutral");
    deps.onStatus(message, "neutral");
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
      const response = await invokeFileTransferWithConnect(deps.capabilityClient, sessionId, "list", {
        path: directory,
      });
      const stream = responsePayloadText(response);
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

  async function uploadFilesToDirectory(files: File[], directory: string, refreshDirectory: boolean): Promise<string[]> {
    if (!deps.isEnabled() || !files.length) return [];
    const sessionId = activeSessionId();
    if (!sessionId) {
      output(deps.tr("status.pluginFileNoSession"), "error");
      return [];
    }
    const targetDirectory = normalizeRemotePath(directory);
    if (!targetDirectory) {
      output(deps.tr("validation.pluginPath"), "error");
      return [];
    }
    output("");
    const uploadedPaths: string[] = [];
    try {
      for (const file of files) {
        const targetPath = uploadTargetPath(targetDirectory, file.name);
        const done = await uploadFileWithConnect(deps.capabilityClient, file, sessionId, targetPath, {
          onProgress: reportProgress,
        });
        const message = metaString(done.meta, "content") || transferProgressText(done.meta);
        output(message, "ok");
        uploadedPaths.push(targetPath);
      }
      if (refreshDirectory) {
        await loadDirectory(targetDirectory);
      }
      deps.onStatus(deps.tr("status.pluginFileUploadDone", {
        name: files.length === 1 ? files[0]?.name ?? "" : String(files.length),
      }), "ok");
      return uploadedPaths;
    } catch (error) {
      output(errorMessage(error), "error");
      deps.onStatus(errorMessage(error), "error");
      return [];
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
        const response = await invokeFileTransferWithConnect(
          deps.capabilityClient,
          sessionId,
          action,
          { path },
          new Uint8Array(),
          action === "download" ? "application/octet-stream" : "text/plain",
        );
        if (action === "download") {
          downloadPluginPayload(
            response.payload,
            metaString(response.meta, "name") || fileNameFromPath(path),
            response.contentType || "application/octet-stream",
          );
        } else {
          const stream = responsePayloadText(response);
          if (stream) {
            output(stream, "ok");
          } else {
            const content = metaString(response.meta, "content");
            if (content) output(content, "ok");
          }
        }
        deps.onStatus(deps.tr("status.pluginFileDone", { operation: action }), "ok");
      } catch (error) {
        output(errorMessage(error), "error");
        deps.onStatus(errorMessage(error), "error");
      }
    },
    async upload(files: File[]) {
      const directory = store.uploadDirectory();
      if (!directory) {
        output(deps.tr("validation.pluginPath"), "error");
        return;
      }
      await uploadFilesToDirectory(files, directory, true);
    },
    async uploadToActivePane(files: File[]) {
      const pane = deps.activePane();
      const directory = normalizeRemotePath(pane?.workingDirectory || "~");
      await uploadFilesToDirectory(files, directory, store.path === directory || store.loadedPath === directory);
    },
    async uploadToDirectory(files: File[], directory: string) {
      const targetDirectory = normalizeRemotePath(directory);
      await uploadFilesToDirectory(
        files,
        targetDirectory,
        store.path === targetDirectory || store.loadedPath === targetDirectory,
      );
    },
    async uploadToTemporaryDirectory(files: File[]): Promise<string[]> {
      if (!files.length) return [];
      const sessionId = activeSessionId();
      if (!sessionId) {
        output(deps.tr("status.pluginFileNoSession"), "error");
        return [];
      }
      const directory = joinRemotePath(TEMP_UPLOAD_ROOT, newTempUploadId());
      const paths = uniqueTempUploadPaths(directory, files);
      output("");
      const uploadedPaths: string[] = [];
      try {
        for (const [index, file] of files.entries()) {
          const targetPath = paths[index] ?? uploadTargetPath(directory, file.name);
          const done = await uploadFileWithConnect(deps.capabilityClient, file, sessionId, targetPath, {
            onProgress: reportProgress,
          });
          const message = metaString(done.meta, "content") || transferProgressText(done.meta);
          output(message, "ok");
          uploadedPaths.push(targetPath);
        }
        deps.onStatus(deps.tr("status.pluginFileUploadDone", {
          name: files.length === 1 ? files[0]?.name ?? "" : String(files.length),
        }), "ok");
        return uploadedPaths;
      } catch (error) {
        output(errorMessage(error), "error");
        deps.onStatus(errorMessage(error), "error");
        return [];
      }
    },
  };
}

function newTempUploadId(): string {
  const id = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `upload-${id.replace(/[^A-Za-z0-9._-]/g, "") || Date.now()}`;
}

function uniqueTempUploadPaths(directory: string, files: File[]): string[] {
  const used = new Set<string>();
  return files.map((file, index) => {
    const name = safeRemoteFileName(file.name, index);
    const uniqueName = uniqueRemoteFileName(name, used);
    used.add(uniqueName);
    return uploadTargetPath(directory, uniqueName);
  });
}

function safeRemoteFileName(name: string, index: number): string {
  const cleaned = name
    .trim()
    .replace(/[\\/\0-\x1f\x7f]+/g, "_")
    .replace(/^\.+$/, "")
    || `upload-${index + 1}`;
  return cleaned.slice(0, 180) || `upload-${index + 1}`;
}

function uniqueRemoteFileName(name: string, used: Set<string>): string {
  if (!used.has(name)) return name;
  const dotIndex = name.lastIndexOf(".");
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : "";
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${extension}`;
    if (!used.has(candidate)) return candidate;
  }
  return `${stem}-${Date.now()}${extension}`;
}
