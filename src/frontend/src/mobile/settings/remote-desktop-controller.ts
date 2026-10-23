import { createMobileRemoteDesktopPreference } from "./remote-desktop-preference";

export function createMobileRemoteDesktopSettings(root: HTMLElement) {
  const preference = createMobileRemoteDesktopPreference();
  const input = root.querySelector<HTMLInputElement>("#mobileRemoteDesktopEnabled")!;
  input.checked = preference.isEnabled();
  const change = () => preference.setEnabled(input.checked);
  input.addEventListener("change", change);
  return {
    isEnabled: preference.isEnabled,
    setAvailable(available: boolean) { root.hidden = !available; },
    dispose() { input.removeEventListener("change", change); },
  };
}
