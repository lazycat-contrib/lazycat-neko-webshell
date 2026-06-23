import { normalizeRemotePath } from "./remote-files";
import type { FileBrowserContextMenu, FileBrowserEntry } from "./types";

export class FileBrowserStore {
  path = "/";
  selectedPath = "";
  entries: FileBrowserEntry[] = [];
  loading = false;
  loadedPath = "";
  paneId = "";
  contextMenu: FileBrowserContextMenu | undefined;

  selectedEntry(): FileBrowserEntry | undefined {
    return this.entries.find((entry) => entry.path === this.selectedPath);
  }

  selectPath(path: string) {
    this.selectedPath = path;
  }

  clearContextMenu() {
    this.contextMenu = undefined;
  }

  openContextMenu(path: string, x: number, y: number) {
    this.selectedPath = path;
    this.contextMenu = { path, x, y };
  }

  uploadDirectory(): string {
    const entry = this.selectedEntry();
    if (entry?.kind === "directory") return entry.path;
    return normalizeRemotePath(this.path);
  }

  beginDirectoryLoad(path: string): string {
    const directory = normalizeRemotePath(path);
    this.loading = true;
    this.path = directory;
    this.contextMenu = undefined;
    return directory;
  }

  finishDirectoryLoad(directory: string, entries: FileBrowserEntry[]) {
    this.entries = entries;
    this.selectedPath = "";
    this.loadedPath = directory;
    this.loading = false;
  }

  failDirectoryLoad() {
    this.entries = [];
    this.loadedPath = "";
    this.loading = false;
  }

  finishDirectoryLoadWithoutChanges() {
    this.loading = false;
  }

  syncPathWithPane(paneId: string, workingDirectory: string, force = false): boolean {
    const cwd = normalizeRemotePath(workingDirectory);
    if (!paneId || !cwd || cwd === "/") return false;
    const paneChanged = this.paneId !== paneId;
    if (!force && !paneChanged && this.loadedPath) return false;
    this.paneId = paneId;
    this.path = cwd;
    this.selectedPath = "";
    this.loadedPath = "";
    return true;
  }
}
