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

export type ClipboardImageStageOptions = {
  onProgress?: (loaded: number, total: number) => void;
};

export async function stageClipboardImage(
  selector: string,
  payload: ClipboardImagePayload,
  options: ClipboardImageStageOptions = {},
): Promise<string> {
  const url = new URL("./api/clipboard-image", window.location.href);
  url.searchParams.set("name", selector);
  url.searchParams.set("extension", payload.extension);

  const result = await new Promise<{ status: number; statusText: string; text: string }>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", url.toString(), true);
    request.withCredentials = true;
    request.setRequestHeader("content-type", "application/octet-stream");
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        options.onProgress?.(event.loaded, event.total);
      }
    };
    request.onload = () => {
      resolve({
        status: request.status,
        statusText: request.statusText,
        text: request.responseText,
      });
    };
    request.onerror = () => reject(new Error(request.statusText || "clipboard image upload failed"));
    request.send(payload.data);
  });

  if (result.status < 200 || result.status >= 300) {
    throw new Error(result.text || result.statusText);
  }
  const json = JSON.parse(result.text || "{}") as { path?: unknown };
  const path = typeof json.path === "string" ? json.path.trim() : "";
  if (!path) throw new Error("clipboard image path is missing");
  return path;
}
