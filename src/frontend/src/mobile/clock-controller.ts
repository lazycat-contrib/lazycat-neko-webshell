import type { MessageKey } from "../i18n";
import type { Settings } from "../types";
import { formatMobileClockTime, renderMobileClockContent } from "./clock";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

type MobileClockElements = {
  clock: HTMLElement;
  enabled: HTMLInputElement;
  use24Hour: HTMLInputElement;
  showPeriod: HTMLInputElement;
};

type MobileClockControllerOptions = {
  elements: MobileClockElements;
  settings: () => Settings;
  tr: Translate;
};

export function createMobileClockController(options: MobileClockControllerOptions) {
  let timer: number | undefined;

  function update() {
    const settings = options.settings();
    const clock = options.elements.clock;
    clock.hidden = !settings.mobileClockEnabled;
    if (!settings.mobileClockEnabled) {
      clock.replaceChildren();
      return;
    }
    const now = new Date();
    const hasPhrases = settings.mobileQuickPhrases.length > 0;
    const showPeriod = !settings.mobileClockUse24Hour && settings.mobileClockShowPeriod;
    const timeText = formatMobileClockTime(now, {
      locale: settings.locale,
      hour12: !settings.mobileClockUse24Hour,
      showPeriod,
      showSeconds: !hasPhrases,
    });
    renderMobileClockContent(clock, timeText);
    clock.dataset.compact = String(hasPhrases);
    clock.dataset.period = String(showPeriod);
    delete clock.dataset.pomodoro;
    clock.setAttribute("aria-label", `${options.tr("label.currentTime")} ${timeText}`);
  }

  function updateSettingsState() {
    const settings = options.settings();
    options.elements.enabled.checked = settings.mobileClockEnabled;
    options.elements.use24Hour.checked = settings.mobileClockUse24Hour;
    options.elements.use24Hour.disabled = !settings.mobileClockEnabled;
    options.elements.showPeriod.checked = settings.mobileClockShowPeriod;
    options.elements.showPeriod.disabled = !settings.mobileClockEnabled || settings.mobileClockUse24Hour;
  }

  return {
    start() {
      update();
      window.clearInterval(timer);
      timer = window.setInterval(update, 1000);
    },
    update,
    updateSettingsState,
  };
}
