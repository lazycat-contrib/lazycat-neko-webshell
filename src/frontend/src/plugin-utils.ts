import type { ActionResponseMeta } from "./action-ws-client";
import type { PluginDescriptor } from "./gen/lazycat/webshell/v1/capability_pb";
import type { MessageKey } from "./i18n";
import { metaBoolean, metaNumber, metaString } from "./json-meta";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

export const FILE_TRANSFER_PLUGIN_ID = "file-transfer";
export const AI_CHAT_PLUGIN_ID = "ai-chat";
export const LIGHTOS_PORT_FORWARD_PLUGIN_ID = "lightos-port-forward";
export const POMODORO_PLUGIN_ID = "pomodoro";
export const PUBLIC_TUNNEL_PLUGIN_ID = "public-tunnel";
export const TERMINAL_TRANSFER_PLUGIN_ID = "terminal-transfer";

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

export function transferProgressText(meta: ActionResponseMeta | undefined): string {
  const name = metaString(meta, "name");
  const percent = metaNumber(meta, "percent");
  const done = metaBoolean(meta, "done");
  const status = `${Number.isFinite(percent) ? `${percent}%` : "..."}`;
  return [name, done ? `${status} complete` : status].filter(Boolean).join(": ");
}

export function pluginDisplayName(plugin: PluginDescriptor, tr: Translate): string {
  if (plugin.id === AI_CHAT_PLUGIN_ID) return tr("plugin.aiChat.name");
  if (plugin.id === FILE_TRANSFER_PLUGIN_ID) return tr("plugin.fileTransfer.name");
  if (plugin.id === LIGHTOS_PORT_FORWARD_PLUGIN_ID) return tr("plugin.lightosPortForward.name");
  if (plugin.id === POMODORO_PLUGIN_ID) return tr("plugin.pomodoro.name");
  if (plugin.id === PUBLIC_TUNNEL_PLUGIN_ID) return tr("plugin.publicTunnel.name");
  if (plugin.id === TERMINAL_TRANSFER_PLUGIN_ID) return tr("plugin.terminalTransfer.name");
  return plugin.displayName || plugin.id;
}

export function pluginIcon(pluginId: string): string {
  if (pluginId === AI_CHAT_PLUGIN_ID) return "message-square-text";
  if (pluginId === FILE_TRANSFER_PLUGIN_ID) return "folder-up";
  if (pluginId === LIGHTOS_PORT_FORWARD_PLUGIN_ID) return "waypoints";
  if (pluginId === POMODORO_PLUGIN_ID) return "timer";
  if (pluginId === PUBLIC_TUNNEL_PLUGIN_ID) return "radio-tower";
  if (pluginId === TERMINAL_TRANSFER_PLUGIN_ID) return "arrow-left-right";
  return "plug";
}

export function pluginDescription(plugin: PluginDescriptor, tr: Translate): string {
  if (plugin.id === AI_CHAT_PLUGIN_ID) return tr("plugin.aiChat.description");
  if (plugin.id === FILE_TRANSFER_PLUGIN_ID) return tr("plugin.fileTransfer.description");
  if (plugin.id === LIGHTOS_PORT_FORWARD_PLUGIN_ID) return tr("plugin.lightosPortForward.description");
  if (plugin.id === POMODORO_PLUGIN_ID) return tr("plugin.pomodoro.description");
  if (plugin.id === PUBLIC_TUNNEL_PLUGIN_ID) return tr("plugin.publicTunnel.description");
  if (plugin.id === TERMINAL_TRANSFER_PLUGIN_ID) return tr("plugin.terminalTransfer.description");
  return plugin.description || plugin.kind || plugin.id;
}

export function pluginMetaLabel(value: string, tr: Translate): string {
  if (value === "ai") return tr("plugin.meta.ai");
  if (value === "filesystem") return tr("plugin.meta.filesystem");
  if (value === "lightos") return tr("plugin.meta.lightos");
  if (value === "network") return tr("plugin.meta.network");
  if (value === "productivity") return tr("plugin.meta.productivity");
  if (value === "session") return tr("plugin.meta.session");
  if (value === "tunnel") return tr("plugin.meta.tunnel");
  if (value === "transfer") return tr("plugin.meta.transfer");
  return value;
}
