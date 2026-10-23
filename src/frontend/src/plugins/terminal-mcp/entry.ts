import type { PluginDescriptor } from "../../gen/lazycat/webshell/v1/capability_pb";
import type { PluginSettingsViewState } from "../../plugin-views";
import { settingsDisabled, type PluginEntry } from "../host";
import { renderTerminalMcpSettingsView } from "./settings-view";
export type EntryResources = Record<string, never>;
export function createEntry(_resources: EntryResources): PluginEntry { return { id: "terminal-mcp" }; }
export function renderSettings(plugin: PluginDescriptor, state: PluginSettingsViewState): string {
  return renderTerminalMcpSettingsView({ ...state.terminalMcp, enabled: plugin.enabled, disabled: settingsDisabled(plugin, state), tr: state.tr });
}
export function isSettingsOpen(): boolean { return false; }
