export async function resolveLightOSHomeUrl(mobileRemoteDesktop = false): Promise<string> {
  const response = await fetch(new URL("./api/lightos-admin-info", window.location.href), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (response.ok) {
    const info = await response.json() as { base_url?: string };
    const baseUrl = info.base_url?.trim();
    if (baseUrl) return buildLightOSHomeUrl(baseUrl, mobileRemoteDesktop);
  }

  const referrerUrl = referrerHomeUrl(mobileRemoteDesktop);
  if (referrerUrl) return referrerUrl;
  throw new Error(response.ok ? "LightOS admin base_url is empty" : await response.text());
}

export function buildLightOSHomeUrl(value: string, mobileRemoteDesktop = false): string {
  const target = new URL(value, window.location.href);
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Invalid LightOS admin URL protocol");
  }
  target.searchParams.set("view", "home");
  target.searchParams.set("mobile_remote_desktop", mobileRemoteDesktop ? "1" : "0");
  return target.toString();
}

export function referrerHomeUrl(mobileRemoteDesktop = false): string {
  try {
    if (!document.referrer) return "";
    const referrer = new URL(document.referrer);
    if (referrer.origin === window.location.origin) return "";
    referrer.pathname = "/";
    referrer.search = "";
    referrer.hash = "";
    return buildLightOSHomeUrl(referrer.toString(), mobileRemoteDesktop);
  } catch {
    return "";
  }
}
