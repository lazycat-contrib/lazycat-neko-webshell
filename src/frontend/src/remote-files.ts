import { stripAnsiForAI } from "./ai-context";
import type { FileBrowserEntry } from "./types";

export function parseFileBrowserEntries(directory: string, text: string): FileBrowserEntry[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line): FileBrowserEntry | undefined => {
      const [name = "", rawKind = "", rawSize = "0", rawLinks = "1", linkTarget = ""] = line.split("\t");
      if (!name) return undefined;
      const links = Number.parseInt(rawLinks, 10);
      const kind = fileKindFromFindType(rawKind, Number.isFinite(links) ? links : 1);
      return {
        name,
        path: joinRemotePath(directory, name),
        kind,
        size: Number.parseInt(rawSize, 10) || 0,
        linkTarget: linkTarget || undefined,
      };
    })
    .filter((entry): entry is FileBrowserEntry => Boolean(entry))
    .sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (left.kind !== "directory" && right.kind === "directory") return 1;
      return left.name.localeCompare(right.name, undefined, { numeric: true });
    });
}

export function fileKindFromFindType(value: string, links: number): FileBrowserEntry["kind"] {
  if (value === "d") return "directory";
  if (value === "l") return "symlink";
  if (value === "f" && links > 1) return "hardlink";
  if (value === "f") return "file";
  return "other";
}

export function fileEntryIcon(entry: FileBrowserEntry): string {
  if (entry.kind === "directory") return "folder";
  if (entry.kind === "symlink") return "file-symlink";
  if (entry.kind === "hardlink") return "files";
  if (entry.kind === "file") return "file";
  return "file-question";
}

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "-";
  if (size < 1024) return `${size} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = size / 1024;
  for (const unit of units) {
    if (value < 1024) return `${value.toFixed(value >= 100 ? 0 : 1)} ${unit}`;
    value /= 1024;
  }
  return `${value.toFixed(1)} PB`;
}

export function normalizeRemotePath(path: string): string {
  const trimmed = path.trim().replace(/\/{2,}/g, "/");
  if (!trimmed) return "/";
  if (trimmed === "~" || trimmed.startsWith("~/")) return trimmed.replace(/\/+$/, "") || "~";
  if (trimmed.startsWith("/")) return trimmed.replace(/\/+$/, "") || "/";
  return `/${trimmed}`.replace(/\/+$/, "") || "/";
}

export function parentRemotePath(path: string): string {
  const normalized = normalizeRemotePath(path);
  if (normalized === "/" || normalized === "~") return normalized;
  if (normalized.startsWith("~/")) {
    const homeParts = normalized.slice(2).split("/").filter(Boolean);
    if (homeParts.length <= 1) return "~";
    return `~/${homeParts.slice(0, -1).join("/")}`;
  }
  const parts = normalized.split("/").filter(Boolean);
  return `/${parts.slice(0, -1).join("/")}` || "/";
}

export function joinRemotePath(directory: string, name: string): string {
  const safeName = name.replace(/^\/+/, "");
  const base = normalizeRemotePath(directory);
  if (base === "/") return `/${safeName}`;
  return `${base.replace(/\/+$/, "")}/${safeName}`;
}

export function workingDirectoryFromOsc7(text: string): string {
  const pattern = /\x1b\]7;file:\/\/[^\x07\x1b/]*(\/[^\x07\x1b]*)(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  let cwd = "";
  while ((match = pattern.exec(text)) !== null) {
    try {
      cwd = decodeURIComponent(match[1] ?? "");
    } catch {
      cwd = match[1] ?? "";
    }
  }
  return normalizeDetectedDirectory(cwd);
}

export function workingDirectoryFromPrompt(text: string): string {
  const clean = stripAnsiForAI(text).split(/\r?\n/).slice(-4).join("\n");
  const pattern = /(?:^|[\s:>])((?:~|\/)[\w.@%+\-/]*)(?=$|[\s)>])/g;
  let match: RegExpExecArray | null;
  let cwd = "";
  while ((match = pattern.exec(clean)) !== null) {
    const candidate = match[1] ?? "";
    if (candidate.length > cwd.length) cwd = candidate;
  }
  return normalizeDetectedDirectory(cwd);
}

export function normalizeDetectedDirectory(value: string): string {
  const cleaned = value.trim().replace(/[.,;:)\]]+$/g, "");
  if (!cleaned || cleaned === "/" || cleaned.includes("\n")) return "";
  if (cleaned === "~" || cleaned.startsWith("~/") || cleaned.startsWith("/")) {
    return normalizeRemotePath(cleaned);
  }
  return "";
}

export function uploadTargetPath(path: string, fileName: string): string {
  return joinRemotePath(path, fileName);
}

export function fileNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || "download";
}
