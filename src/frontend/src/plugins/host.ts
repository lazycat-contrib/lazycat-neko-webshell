import type { TerminalStreamHook } from "./terminal-stream";
import type { PluginDescriptor } from "../gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "../i18n";
import type { PluginSettingsViewState } from "../plugin-views";

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;
export type CommonResources = {
  tr: Translate;
  disabled: (plugin: PluginDescriptor) => boolean;
};

export type PluginEntry = {
  id: string;
  stream?: TerminalStreamHook;
  render?: (plugin: PluginDescriptor) => string;
  prepare?: () => void;
  rendered?: () => void;
  configured?: (plugin: PluginDescriptor) => void;
};

export function settingsDisabled(plugin: PluginDescriptor, state: PluginSettingsViewState): boolean {
  return state.pluginsLoading || state.savingPluginIds.has(plugin.id);
}
