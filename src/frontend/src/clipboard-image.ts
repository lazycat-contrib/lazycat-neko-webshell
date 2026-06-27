import { MAX_CLIPBOARD_IMAGE_BYTES } from "./config";
import type { ClipboardImagePayload } from "./types";

export type ImageFilePayloadErrorCode = "unsupported-heic" | "too-large" | "compressed-too-large" | "decode-failed";

export class ImageFilePayloadError extends Error {
  constructor(readonly code: ImageFilePayloadErrorCode, message: string) {
    super(message);
  }
}

export const IMAGE_FILE_ACCEPT = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
].join(",");

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

export async function imageFilePayload(file: File): Promise<ClipboardImagePayload> {
  const contentType = imageContentType(file);
  if (isHeicImage(file, contentType)) {
    throw new ImageFilePayloadError("unsupported-heic", "HEIC/HEIF images are not supported");
  }
  if (file.size <= MAX_CLIPBOARD_IMAGE_BYTES) {
    return imageBlobPayload(file, contentType);
  }
  if (!compressibleImageType(contentType)) {
    throw new ImageFilePayloadError("too-large", "image is too large");
  }
  const compressed = await compressImageFile(file);
  return imageBlobPayload(compressed, compressed.type || "image/jpeg");
}

export function isImageFileCandidate(file: File): boolean {
  const declared = file.type.trim().toLowerCase();
  if (declared.startsWith("image/")) return true;
  return /\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name.trim());
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
  if (type === "image/heic") return "heic";
  if (type === "image/heif") return "heif";
  return "png";
}

function imageContentType(file: File): string {
  const declared = file.type.trim().toLowerCase();
  if (declared) return declared;
  const name = file.name.trim().toLowerCase();
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".gif")) return "image/gif";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".heic")) return "image/heic";
  if (name.endsWith(".heif")) return "image/heif";
  return "image/png";
}

function isHeicImage(file: File, contentType: string): boolean {
  const name = file.name.trim().toLowerCase();
  return contentType === "image/heic"
    || contentType === "image/heif"
    || name.endsWith(".heic")
    || name.endsWith(".heif");
}

function compressibleImageType(contentType: string): boolean {
  return contentType === "image/jpeg" || contentType === "image/png" || contentType === "image/webp";
}

async function compressImageFile(file: File): Promise<Blob> {
  const image = await loadImageFromFile(file);
  const maxDimension = 1920;
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("image compression is not available");
  context.drawImage(image, 0, 0, width, height);

  let quality = 0.82;
  let blob = await canvasToBlob(canvas, "image/jpeg", quality);
  while (blob.size > MAX_CLIPBOARD_IMAGE_BYTES && quality > 0.48) {
    quality -= 0.12;
    blob = await canvasToBlob(canvas, "image/jpeg", quality);
  }
  if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ImageFilePayloadError("compressed-too-large", "compressed image is too large");
  }
  return blob;
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("failed to read image"));
    reader.onload = () => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new ImageFilePayloadError("decode-failed", "failed to decode image"));
      image.src = typeof reader.result === "string" ? reader.result : "";
    };
    reader.readAsDataURL(file);
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("failed to compress image"));
      }
    }, type, quality);
  });
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
