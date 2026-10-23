import { BUILTIN_PLUGINS } from "./catalog.generated.ts";
import type { PluginEntry } from "./host";
import type { TerminalPane } from "../types";

export type TerminalStreamHook = {
  consumePaneOutput: (pane: TerminalPane, bytes: Uint8Array) => boolean;
  consumePaneInput: (pane: TerminalPane, text: string) => boolean;
  resetPane: (pane: TerminalPane, message?: string) => void;
  resizePane: (pane: TerminalPane, columns: number) => void;
};

type ResourceDeclaration = { id: string; resources: readonly string[] };

/** The host keeps the byte path and pane lifecycle; declared hooks can consume a transfer. */
export function createPluginStreamBroker(
  entries: Iterable<PluginEntry>,
  declarations: readonly ResourceDeclaration[] = BUILTIN_PLUGINS,
): TerminalStreamHook {
  const hooks: TerminalStreamHook[] = [];
  for (const entry of entries) {
    if (!entry.stream) continue;
    if (!declarations.some((plugin) => plugin.id === entry.id && plugin.resources.includes("terminal-stream"))) {
      throw new Error(`Undeclared terminal-stream resource: ${entry.id}`);
    }
    hooks.push(entry.stream);
  }
  return {
    consumePaneOutput: (pane, bytes) => hooks.some((hook) => hook.consumePaneOutput(pane, bytes)),
    consumePaneInput: (pane, text) => hooks.some((hook) => hook.consumePaneInput(pane, text)),
    resetPane: (pane, message) => { for (const hook of hooks) hook.resetPane(pane, message); },
    resizePane: (pane, columns) => { for (const hook of hooks) hook.resizePane(pane, columns); },
  };
}
