import type { PluginDescriptor } from "../gen/lazycat/webshell/v1/capability_pb";
import type { SessionBackendId } from "../types";
import { BUILTIN_PLUGINS } from "./catalog.generated.ts";

const BACKENDS_METADATA = "backends";
const PLUGIN_TOOL_IDS = new Set<string>(BUILTIN_PLUGINS.filter((plugin) => plugin.frontend.tool).map((plugin) => plugin.id));

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
