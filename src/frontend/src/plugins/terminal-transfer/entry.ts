import type { PluginDescriptor } from "../../gen/lazycat/webshell/v1/capability_pb";
import type { PluginSettingsViewState } from "../../plugin-views";
import type { SessionBackendId } from "../../types";
import type { TerminalTransferProtocolSupport } from "../../terminal-transfer/types";
import { settingsDisabled, type CommonResources, type PluginEntry } from "../host";
import type { createTerminalTransferController } from "./controller";
import { renderTerminalTransferToolView } from "./tool-view";
import { renderTerminalTransferSettingsView } from "./settings-view";

export type EntryResources = CommonResources & {
  controller: ReturnType<typeof createTerminalTransferController>;
  backend: () => SessionBackendId | undefined;
  protocols: () => TerminalTransferProtocolSupport;
};
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "terminal-transfer",
    stream: resources.controller,
    render: (plugin) => renderTerminalTransferToolView({ disabled: resources.disabled(plugin), activeBackend: resources.backend(), protocols: resources.protocols(), state: resources.controller.viewState(), tr: resources.tr }),
    configured: (plugin) => { if (!plugin.enabled) resources.controller.cancel(); },
  };
}
export function renderSettings(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  return renderTerminalTransferSettingsView({ ...state.terminalTransfer, disabled: settingsDisabled(plugin, state), tr: state.tr });
}
export function isSettingsOpen(): boolean { return false; }
