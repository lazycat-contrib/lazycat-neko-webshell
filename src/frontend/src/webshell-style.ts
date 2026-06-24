import { isLightInterfaceStyle } from "./appearance-settings";
import type { InterfaceStyleId, Settings } from "./types";

type WebshellStyleSettings = Pick<
  Settings,
  "herdrActiveBackgroundDark" | "herdrActiveBackgroundLight" | "interfaceStyleId" | "tabLayout"
>;

const DEFAULT_HERDR_ACTIVE_BACKGROUNDS = new Set(["#06193a", "#f0f7ff"]);

export function applyWebshellStyle(target: HTMLElement, settings: WebshellStyleSettings) {
  const light = isLightInterfaceStyle(settings.interfaceStyleId);
  target.dataset.tabLayout = settings.tabLayout;
  target.dataset.interfaceStyle = settings.interfaceStyleId;
  target.dataset.interfaceTone = light ? "light" : "dark";
  target.style.setProperty("--herdr-active-bg", herdrActiveBackground(settings));
  target.style.setProperty("--herdr-active-fg", herdrActiveForeground(settings));
}

export function herdrActiveBackground(
  settings: Pick<WebshellStyleSettings, "herdrActiveBackgroundDark" | "herdrActiveBackgroundLight"> & {
    interfaceStyleId: InterfaceStyleId;
  },
): string {
  const light = isLightInterfaceStyle(settings.interfaceStyleId);
  const value = light ? settings.herdrActiveBackgroundLight : settings.herdrActiveBackgroundDark;
  return isDefaultHerdrActiveBackground(value) ? "var(--accent-soft)" : value;
}

function herdrActiveForeground(
  settings: Pick<WebshellStyleSettings, "herdrActiveBackgroundDark" | "herdrActiveBackgroundLight"> & {
    interfaceStyleId: InterfaceStyleId;
  },
): string {
  const light = isLightInterfaceStyle(settings.interfaceStyleId);
  const value = light ? settings.herdrActiveBackgroundLight : settings.herdrActiveBackgroundDark;
  return isDefaultHerdrActiveBackground(value) ? "var(--accent-fg)" : light ? "#171717" : "#f4fff8";
}

function isDefaultHerdrActiveBackground(value: string): boolean {
  return DEFAULT_HERDR_ACTIVE_BACKGROUNDS.has(value.trim().toLowerCase());
}
