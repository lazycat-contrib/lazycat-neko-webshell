import { renderMobileClockSettingsView } from "./settings/clock-view";
import { renderMobileQuickPhraseSettingsView } from "./settings/quick-phrase-view";
import { renderMobileTouchSettingsView } from "./settings/touch-view";

export function renderMobileSettingsView(): string {
  return `
            <section class="settings-section" id="mobileSettingsPanel" data-settings-panel="mobile" role="tabpanel" hidden>
              ${renderMobileClockSettingsView()}
              ${renderMobileTouchSettingsView()}
              ${renderMobileQuickPhraseSettingsView()}
            </section>
  `;
}
