import type { PluginDescriptor } from "../gen/lazycat/webshell/v1/capability_pb";
import type { SessionBackendId } from "../types";
import {
  AI_CHAT_PLUGIN_ID,
  FILE_TRANSFER_PLUGIN_ID,
  LIGHTOS_PORT_FORWARD_PLUGIN_ID,
  POMODORO_PLUGIN_ID,
  PUBLIC_TUNNEL_PLUGIN_ID,
  TERMINAL_TRANSFER_PLUGIN_ID,
  WHITE_NOISE_PLUGIN_ID,
} from "../plugin-utils";

const BACKENDS_METADATA = "backends";

const PLUGIN_TOOL_IDS = new Set([
  FILE_TRANSFER_PLUGIN_ID,
  AI_CHAT_PLUGIN_ID,
  LIGHTOS_PORT_FORWARD_PLUGIN_ID,
  POMODORO_PLUGIN_ID,
  WHITE_NOISE_PLUGIN_ID,
  PUBLIC_TUNNEL_PLUGIN_ID,
  TERMINAL_TRANSFER_PLUGIN_ID,
]);

export function enabledPluginTools(
  plugins: PluginDescriptor[],
  activeBackend?: SessionBackendId,
): PluginDescriptor[] {
  return plugins.filter((plugin) =>
    plugin.enabled
    && PLUGIN_TOOL_IDS.has(plugin.id)
    && pluginToolSupportsBackend(plugin, activeBackend)
  );
}

export function resolveActivePluginToolId(tools: PluginDescriptor[], activeId: string): string {
  return tools.some((plugin) => plugin.id === activeId) ? activeId : tools[0]?.id ?? "";
}

function pluginToolSupportsBackend(
  plugin: PluginDescriptor,
  activeBackend?: SessionBackendId,
): boolean {
  const supported = plugin.metadata[BACKENDS_METADATA]
    ?.split(",")
    .map((backend) => backend.trim())
    .filter(Boolean);
  if (!supported?.length || !activeBackend) return true;
  return supported.includes(activeBackend);
}
