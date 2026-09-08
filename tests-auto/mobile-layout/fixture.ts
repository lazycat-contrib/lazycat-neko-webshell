import "../../src/frontend/src/styles.css";
import "../../src/frontend/src/plugin-tools.css";
import "../../src/frontend/src/webshell-themes.css";
import "../../src/frontend/src/mobile/styles.css";
import { createIcons, icons } from "lucide";
import { renderMobileKeyboardLayoutSettingsView } from "../../src/frontend/src/mobile/settings/keyboard-layout-view.ts";
import { createMobileKeyboardLayoutSettingsController } from "../../src/frontend/src/mobile/keyboard-layout-settings-controller.ts";
import { mobileKeyboardPresetLayout } from "../../src/frontend/src/mobile/keyboard-layout.ts";
import type { MobileKeyboardPresetId } from "../../src/frontend/src/mobile/keyboard-layout-types.ts";
import { translate } from "../../src/frontend/src/i18n.ts";

const root = document.querySelector<HTMLElement>("#fixture")!;
document.body.style.cssText = "overflow:auto;height:auto;min-height:100vh;display:block";
root.style.cssText = "max-width:760px;margin:auto;padding:12px;overflow:visible";
root.innerHTML = renderMobileKeyboardLayoutSettingsView();
const locale = new URLSearchParams(location.search).get("locale") === "zh-CN" ? "zh-CN" : "en";
root.querySelectorAll<HTMLElement>("[data-i18n]").forEach((node) => { node.textContent = translate(locale, node.dataset.i18n as Parameters<typeof translate>[1]); });
let preset: MobileKeyboardPresetId = "default";
let layout = mobileKeyboardPresetLayout("default");
let saves = 0;
const controller = createMobileKeyboardLayoutSettingsController({
 root, preset: () => preset, layout: () => layout,
 setPreset: (value) => { preset = value; }, setLayout: (value) => { layout = value; },
 save: () => { saves++; }, changed: () => {}, updateIcons: () => createIcons({ icons }),
 tr: (key, values) => translate(locale, key, values),
});
controller.bind();
Object.assign(window, { layoutFixture: { state: () => ({ preset, layout, saves }), ready: true } });
