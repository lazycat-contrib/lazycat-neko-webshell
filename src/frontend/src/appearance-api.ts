import { mimeTypeForFont, mimeTypeForTerminalBackground } from "./appearance-settings";
import type { StoredFont, TerminalBackground } from "./types";

export async function fetchStoredFonts(): Promise<StoredFont[]> {
  const response = await fetch(new URL("./api/fonts", window.location.href), {
    credentials: "same-origin",
  });
  await throwIfFailed(response);
  return response.json() as Promise<StoredFont[]>;
}

export async function uploadFontFile(file: File): Promise<StoredFont> {
  const url = new URL("./api/fonts", window.location.href);
  url.searchParams.set("filename", file.name);
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": file.type || mimeTypeForFont(file.name) },
    body: file,
  });
  await throwIfFailed(response);
  return response.json() as Promise<StoredFont>;
}

export async function deleteStoredFont(id: string): Promise<void> {
  const response = await fetch(new URL(`./api/fonts/${encodeURIComponent(id)}`, window.location.href), {
    method: "DELETE",
    credentials: "same-origin",
  });
  await throwIfFailed(response, { allowNotFound: true });
}

export async function uploadTerminalBackgroundFile(file: File): Promise<TerminalBackground> {
  const url = new URL("./api/terminal-backgrounds", window.location.href);
  url.searchParams.set("filename", file.name);
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": file.type || mimeTypeForTerminalBackground(file.name) },
    body: file,
  });
  await throwIfFailed(response);
  return response.json() as Promise<TerminalBackground>;
}

export async function deleteTerminalBackgroundFile(id: string): Promise<void> {
  const response = await fetch(new URL(`./api/terminal-backgrounds/${encodeURIComponent(id)}`, window.location.href), {
    method: "DELETE",
    credentials: "same-origin",
  });
  await throwIfFailed(response, { allowNotFound: true });
}

async function throwIfFailed(response: Response, options: { allowNotFound?: boolean } = {}) {
  if (response.ok || (options.allowNotFound && response.status === 404)) return;
  throw new Error(await response.text() || response.statusText);
}
