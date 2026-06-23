import { isLightInterfaceStyle } from "./appearance-settings";
import type { InterfaceStyleId, Settings } from "./types";

type WebshellStyleSettings = Pick<
  Settings,
  "herdrActiveBackgroundDark" | "herdrActiveBackgroundLight" | "interfaceStyleId" | "tabLayout"
>;

export function applyWebshellStyle(target: HTMLElement, settings: WebshellStyleSettings) {
  const light = isLightInterfaceStyle(settings.interfaceStyleId);
  target.dataset.tabLayout = settings.tabLayout;
  target.dataset.interfaceStyle = settings.interfaceStyleId;
  target.dataset.interfaceTone = light ? "light" : "dark";
  target.style.setProperty("--herdr-active-bg", herdrActiveBackground(settings));
  target.style.setProperty("--herdr-active-fg", light ? "#17231d" : "#f4fff8");
}

export function herdrActiveBackground(
  settings: Pick<WebshellStyleSettings, "herdrActiveBackgroundDark" | "herdrActiveBackgroundLight"> & {
    interfaceStyleId: InterfaceStyleId;
  },
): string {
  return isLightInterfaceStyle(settings.interfaceStyleId)
    ? settings.herdrActiveBackgroundLight
    : settings.herdrActiveBackgroundDark;
}
