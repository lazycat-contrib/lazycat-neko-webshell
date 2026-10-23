import type { PluginDescriptor } from "../../gen/lazycat/webshell/v1/capability_pb";
import type { PluginSettingsViewState } from "../../plugin-views";
import { settingsDisabled, type CommonResources, type PluginEntry } from "../host";
import type { createPublicTunnelController } from "./controller";
import type { LightOsForwardInfo } from "../lightos-port-forward/types";
import type { TunnelProviderProfileSummary } from "./types";
import { renderPublicTunnelToolView } from "./tool-view";
import { renderPublicTunnelSettingsView } from "./settings-view";

export type EntryResources = CommonResources & {
  controller: ReturnType<typeof createPublicTunnelController>;
  profiles: () => TunnelProviderProfileSummary[];
  forwards: () => LightOsForwardInfo[];
};
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "public-tunnel",
    prepare: () => resources.controller.syncProviderSelection(),
    configured: () => resources.controller.syncProviderSelection(),
    render: (plugin) => renderPublicTunnelToolView({
      disabled: resources.disabled(plugin), ...resources.controller.state(), ngrokProfiles: resources.profiles(), forwards: resources.forwards(), tr: resources.tr,
    }),
    rendered: () => {
      const state = resources.controller.state();
      if (!state.loaded && !state.loading) void resources.controller.list();
    },
  };
}
export function renderSettings(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  return renderPublicTunnelSettingsView({ ...state.publicTunnel, disabled: settingsDisabled(plugin, state), tr: state.tr });
}
export function isSettingsOpen(state: PluginSettingsViewState): boolean { return Boolean(state.publicTunnel.dialog); }
