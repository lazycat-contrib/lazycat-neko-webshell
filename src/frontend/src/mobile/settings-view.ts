import { renderMobileClockSettingsView } from "./settings/clock-view";
import { renderMobileQuickPhraseSettingsView } from "./settings/quick-phrase-view";
import { renderMobileTouchSettingsView } from "./settings/touch-view";
import { renderMobileKeyboardLayoutSettingsView } from "./settings/keyboard-layout-view";
import { renderSettingsSectionIntro } from "../settings/navigation-view";

export function renderMobileSettingsView(): string {
  return `
            <section class="settings-section" id="mobileSettingsPanel" data-settings-panel="mobile" role="tabpanel" aria-labelledby="settings-tab-mobile" hidden>
              ${renderSettingsSectionIntro("mobile")}
              ${renderMobileClockSettingsView()}
              ${renderMobileTouchSettingsView()}
              ${renderMobileKeyboardLayoutSettingsView()}
              ${renderMobileQuickPhraseSettingsView()}
            </section>
  `;
}
