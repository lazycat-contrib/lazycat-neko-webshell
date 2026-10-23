import type { PluginDescriptor } from "../../gen/lazycat/webshell/v1/capability_pb";
import type { PluginSettingsViewState } from "../../plugin-views";
import { settingsDisabled, type CommonResources, type PluginEntry } from "../host";
import type { createWhiteNoiseController } from "./controller";
import { renderWhiteNoiseToolSurface } from "./runtime";
import { renderWhiteNoiseSettingsView } from "./settings-view";

export type EntryResources = CommonResources & { controller: ReturnType<typeof createWhiteNoiseController> };
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "white-noise",
    render: (plugin) => renderWhiteNoiseToolSurface(plugin, resources.controller, resources.disabled(plugin), resources.tr),
    rendered: () => {
      const state = resources.controller.viewState();
      if (!state.loading && !state.tracks.length && !state.error) void resources.controller.ensureLoaded();
    },
    configured: (plugin) => { if (!plugin.enabled) resources.controller.pause(); },
  };
}
export function renderSettings(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  return renderWhiteNoiseSettingsView({ ...state.whiteNoise, disabled: settingsDisabled(plugin, state), tr: state.tr });
}
export function isSettingsOpen(): boolean { return false; }
