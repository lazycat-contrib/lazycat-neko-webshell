import type { CommonResources, PluginEntry } from "../host";
import type { createLightOsPortForwardController } from "./controller";
import { renderLightOsPortForwardToolView } from "./tool-view";

export type EntryResources = CommonResources & { controller: ReturnType<typeof createLightOsPortForwardController> };
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "lightos-port-forward",
    render: (plugin) => renderLightOsPortForwardToolView({ disabled: resources.disabled(plugin), ...resources.controller.state(), tr: resources.tr }),
    rendered: () => {
      const state = resources.controller.state();
      if (!state.loaded && !state.loading) void resources.controller.list();
    },
  };
}
export function renderSettings(): string { return ""; }
export function isSettingsOpen(): boolean { return false; }
