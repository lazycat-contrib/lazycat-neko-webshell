import { MAX_CLIPBOARD_IMAGE_BYTES } from "./config";
import type { ClipboardImagePayload } from "./types";

export function clipboardImageFile(data: DataTransfer | null | undefined): File | undefined {
  if (!data?.items) return undefined;
  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return undefined;
}

export async function readClipboardImagePayload(): Promise<ClipboardImagePayload | undefined> {
  if (!navigator.clipboard?.read) return undefined;
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((candidate) => candidate.startsWith("image/"));
      if (!type) continue;
      const blob = await item.getType(type);
      return imageBlobPayload(blob, type);
    }
  } catch {
  }
  return undefined;
}

export async function imageBlobPayload(blob: Blob, contentType: string): Promise<ClipboardImagePayload> {
  if (blob.size <= 0) {
    throw new Error("clipboard image is empty");
  }
  if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new Error(`clipboard image exceeds ${Math.floor(MAX_CLIPBOARD_IMAGE_BYTES / (1024 * 1024))} MiB`);
  }
  return {
    extension: imageExtension(contentType),
    data: await blob.arrayBuffer(),
  };
}

export function imageExtension(contentType: string): string {
  const type = contentType.toLowerCase();
  if (type === "image/jpeg" || type === "image/jpg") return "jpg";
  if (type === "image/gif") return "gif";
  if (type === "image/webp") return "webp";
  if (type === "image/bmp") return "bmp";
  return "png";
}

export function clipboardImagePayloadIsValid(payload: ClipboardImagePayload): boolean {
  return payload.data.byteLength > 0 && payload.data.byteLength <= MAX_CLIPBOARD_IMAGE_BYTES;
}

export async function stageClipboardImage(selector: string, payload: ClipboardImagePayload): Promise<string> {
  const url = new URL("./api/clipboard-image", window.location.href);
  url.searchParams.set("name", selector);
  url.searchParams.set("extension", payload.extension);
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/octet-stream" },
    body: payload.data,
  });
  if (!response.ok) {
    throw new Error(await response.text() || response.statusText);
  }
  const result = await response.json() as { path?: unknown };
  const path = typeof result.path === "string" ? result.path.trim() : "";
  if (!path) throw new Error("clipboard image path is missing");
  return path;
}
