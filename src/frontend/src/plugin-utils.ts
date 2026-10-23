import { BUILTIN_PLUGINS, PLUGIN_IDS } from "./plugins/catalog.generated.ts";
import type { PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "./i18n";
import { metaBoolean, metaNumber, metaString } from "./json-meta.ts";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export const FILE_TRANSFER_PLUGIN_ID = PLUGIN_IDS.FILE_TRANSFER;
export const AI_CHAT_PLUGIN_ID = PLUGIN_IDS.AI_CHAT;
export const LIGHTOS_PORT_FORWARD_PLUGIN_ID = PLUGIN_IDS.LIGHTOS_PORT_FORWARD;
export const POMODORO_PLUGIN_ID = PLUGIN_IDS.POMODORO;
export const PUBLIC_TUNNEL_PLUGIN_ID = PLUGIN_IDS.PUBLIC_TUNNEL;
export const TERMINAL_MCP_PLUGIN_ID = PLUGIN_IDS.TERMINAL_MCP;
export const TERMINAL_TRANSFER_PLUGIN_ID = PLUGIN_IDS.TERMINAL_TRANSFER;
export const WHITE_NOISE_PLUGIN_ID = PLUGIN_IDS.WHITE_NOISE;

export function downloadPluginPayload(payload: Uint8Array, name: string, contentType: string) {
  const bytes = new Uint8Array(payload);
  const blob = new Blob([bytes.buffer], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noreferrer";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function transferProgressText(meta: Record<string, unknown> | undefined): string {
  const name = metaString(meta, "name");
  const percent = metaNumber(meta, "percent");
  const done = metaBoolean(meta, "done");
  const status = `${Number.isFinite(percent) ? `${percent}%` : "..."}`;
  return [name, done ? `${status} complete` : status].filter(Boolean).join(": ");
}

function pluginDefinition(id: string) { return BUILTIN_PLUGINS.find((plugin) => plugin.id === id); }

export function pluginDisplayName(plugin: PluginDescriptor, tr: Translate): string {
  const entry = pluginDefinition(plugin.id);
  return entry ? tr(entry.frontend.nameKey as MessageKey) : plugin.displayName || plugin.id;
}

export function pluginIcon(pluginId: string): string {
  return pluginDefinition(pluginId)?.frontend.icon ?? "plug";
}

export function pluginDescription(plugin: PluginDescriptor, tr: Translate): string {
  const entry = pluginDefinition(plugin.id);
  return entry ? tr(entry.frontend.descriptionKey as MessageKey) : plugin.description || plugin.kind || plugin.id;
}

export function pluginMetaLabel(value: string, tr: Translate): string {
  if (value === "ai") return tr("plugin.meta.ai");
  if (value === "automation") return tr("plugin.meta.automation");
  if (value === "filesystem") return tr("plugin.meta.filesystem");
  if (value === "lightos") return tr("plugin.meta.lightos");
  if (value === "mcp") return tr("plugin.meta.mcp");
  if (value === "network") return tr("plugin.meta.network");
  if (value === "productivity") return tr("plugin.meta.productivity");
  if (value === "session") return tr("plugin.meta.session");
  if (value === "sound") return tr("plugin.meta.sound");
  if (value === "terminal") return tr("plugin.meta.terminal");
  if (value === "tunnel") return tr("plugin.meta.tunnel");
  if (value === "transfer") return tr("plugin.meta.transfer");
  return value;
}
