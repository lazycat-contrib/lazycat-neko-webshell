export const MOBILE_REMOTE_DESKTOP_STORAGE_KEY = "lightos-mobile-remote-desktop-enabled";

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function browserStorage(): PreferenceStorage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}

/** This browser's LightOS home preference, independent of the debug tools. */
export function createMobileRemoteDesktopPreference(storage = browserStorage()) {
  let enabled = false;
  try { enabled = storage?.getItem(MOBILE_REMOTE_DESKTOP_STORAGE_KEY) === "true"; }
  catch { /* Browser storage may be unavailable. */ }

  return {
    isEnabled: () => enabled,
    setEnabled(value: boolean) {
      enabled = value === true;
      try { storage?.setItem(MOBILE_REMOTE_DESKTOP_STORAGE_KEY, String(enabled)); }
      catch { /* Keep the selection for this page when persistence is unavailable. */ }
    },
  };
}
