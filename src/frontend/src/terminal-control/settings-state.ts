import type { Settings } from "../types";

type TerminalControlSettingsInputs = {
  terminalSingleControllerMode: HTMLInputElement;
  terminalBlurObservers: HTMLInputElement;
};

export function syncTerminalControlSettingsInputs(
  elements: TerminalControlSettingsInputs,
  settings: Settings,
) {
  elements.terminalSingleControllerMode.checked = settings.terminalSingleControllerMode;
  elements.terminalBlurObservers.checked = settings.terminalBlurObservers;
  elements.terminalBlurObservers.disabled = !settings.terminalSingleControllerMode;
}
