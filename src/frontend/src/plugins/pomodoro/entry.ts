import type { CommonResources, PluginEntry } from "../host";
import type { createPomodoroController } from "./controller";
import { pomodoroToolViewState } from "./tool-presenter";
import { renderPomodoroToolView } from "./tool-view";

export type EntryResources = CommonResources & {
  controller: ReturnType<typeof createPomodoroController>;
  formatDeadline: (date: Date) => string;
};
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "pomodoro",
    render: (plugin) => {
      const view = resources.controller.viewState();
      return renderPomodoroToolView(pomodoroToolViewState({
        disabled: resources.disabled(plugin), state: view.state, draftMinutes: view.draftMinutes,
        draftRounds: view.draftRounds, tr: resources.tr, formatDeadline: resources.formatDeadline,
      }));
    },
  };
}
export function renderSettings(): string { return ""; }
export function isSettingsOpen(): boolean { return false; }
