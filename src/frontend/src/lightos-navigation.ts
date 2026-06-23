export async function resolveLightOSHomeUrl(): Promise<string> {
  const response = await fetch(new URL("./api/lightos-admin-info", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.ok) {
    const info = await response.json() as { base_url?: string };
    const baseUrl = info.base_url?.trim();
    if (baseUrl) return buildLightOSHomeUrl(baseUrl);
  }

  const referrerUrl = referrerHomeUrl();
  if (referrerUrl) return referrerUrl;
  throw new Error(response.ok ? "LightOS admin base_url is empty" : await response.text());
}

export function buildLightOSHomeUrl(value: string): string {
  const target = new URL(value, window.location.href);
  target.searchParams.set("view", "home");
  return target.toString();
}

export function referrerHomeUrl(): string {
  try {
    if (!document.referrer) return "";
    const referrer = new URL(document.referrer);
    if (referrer.origin === window.location.origin) return "";
    referrer.pathname = "/";
    referrer.search = "";
    referrer.hash = "";
    return buildLightOSHomeUrl(referrer.toString());
  } catch {
    return "";
  }
}
