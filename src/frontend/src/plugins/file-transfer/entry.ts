import type { CommonResources, PluginEntry } from "../host";
import type { createFileTransferController } from "./controller";
import { renderFileTransferToolView } from "./tool-view";

export type EntryResources = CommonResources & { controller: ReturnType<typeof createFileTransferController> };
export function createEntry(resources: EntryResources): PluginEntry {
  return {
    id: "file-transfer",
    prepare: () => resources.controller.syncPathWithPane(),
    render: (plugin) => renderFileTransferToolView({ disabled: resources.disabled(plugin), ...resources.controller.viewState(), tr: resources.tr }),
    rendered: () => { void resources.controller.loadCurrentDirectoryIfStale(); },
  };
}
export function renderSettings(): string { return ""; }
export function isSettingsOpen(): boolean { return false; }
