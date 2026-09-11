import type { SecretFileTarget } from "./state.ts";

export async function createSecretFile(target: SecretFileTarget, payload: Uint8Array<ArrayBuffer>): Promise<{ path: unknown }> {
  const url = new URL("./api/secret-files", window.location.href);
  url.searchParams.set("sessionId", target.sessionId);
  url.searchParams.set("selector", target.selector);
  return request(url, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: payload,
  });
}

export async function deleteSecretFile(target: SecretFileTarget, path: string): Promise<void> {
  await request(new URL("./api/secret-files", window.location.href), {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId: target.sessionId, selector: target.selector, path }),
  });
}

async function request(url: URL, init: RequestInit): Promise<{ path: unknown }> {
  const response = await fetch(url, {
    ...init, credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`secret file request failed: ${response.status}`);
  return await response.json() as { path: unknown };
}
